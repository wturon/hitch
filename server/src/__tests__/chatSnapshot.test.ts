import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import * as schema from "../db/schema.js";

// Same throwaway-container harness as db.test.ts / routes.test.ts.
let dockerError: string | null = null;
try {
  execSync("docker info", { stdio: "pipe" });
} catch (error) {
  dockerError = error instanceof Error ? error.message : String(error);
}

if (dockerError) {
  console.error(
    `[chatSnapshot.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const CONTAINER_NAME = `hitch-chat-snapshot-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

process.env.BETTER_AUTH_SECRET ??= "hitch-test-secret-do-not-use-in-prod";

const USER_A = "snap-user-a";
const USER_B = "snap-user-b";

describeDb("chat snapshot + client chat reads (postgres:16 in Docker)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};

  const signUp = async (key: string) => {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: key,
        email: `${key}@test.local`,
        password: `password-for-${key}`,
      }),
    });
    if (res.status !== 200) {
      throw new Error(`sign-up for ${key} failed: ${res.status} ${await res.text()}`);
    }
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error(`sign-up for ${key} returned no session cookie`);
    cookies[key] = setCookie.split(";")[0];
  };

  const api = (userKey: string, method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        cookie: cookies[userKey],
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const json = async (res: Response) => (await res.json()) as any;

  const registerMachine = async (userKey: string, name: string) => {
    const res = await api(userKey, "POST", "/daemon/machines", {
      name,
      daemonVersion: "0.0.1-test",
    });
    expect(res.status).toBe(201);
    return json(res);
  };

  // A minimal §7 payload. `truncated` defaults false = coverage complete.
  const snapshot = (
    chats: unknown[],
    opts: { truncated?: boolean; events?: unknown[]; observedAt?: string } = {},
  ) => ({
    observedAt: opts.observedAt ?? new Date().toISOString(),
    window: {
      since: new Date(Date.now() - 24 * 3600_000).toISOString(),
      cap: 60,
      ...(opts.truncated !== undefined ? { truncated: opts.truncated } : {}),
    },
    chats,
    ...(opts.events ? { events: opts.events } : {}),
  });

  const put = (userKey: string, machineId: string, body: unknown) =>
    api(userKey, "PUT", `/daemon/machines/${machineId}/chat-snapshot`, body);

  const chatsOf = async (userKey: string, machineId: string) => {
    const res = await api(userKey, "GET", `/chats?machine_id=${machineId}`);
    expect(res.status).toBe(200);
    return (await json(res)) as any[];
  };

  beforeAll(async () => {
    execSync(
      `docker run -d --rm --name ${CONTAINER_NAME} ` +
        `-e POSTGRES_PASSWORD=hitch -e POSTGRES_DB=hitch ` +
        `-p 127.0.0.1:0:5432 postgres:16`,
      { stdio: "pipe" },
    );

    const portLine = execSync(`docker port ${CONTAINER_NAME} 5432/tcp`, { encoding: "utf8" })
      .split("\n")[0]
      .trim();
    const port = portLine.split(":").pop();
    const connectionString = `postgres://postgres:hitch@127.0.0.1:${port}/hitch`;

    let lastError: unknown;
    for (let attempt = 0; attempt < 60; attempt++) {
      const client = new pg.Client({ connectionString });
      try {
        await client.connect();
        await client.query("SELECT 1");
        await client.end();
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await client.end().catch(() => {});
        await sleep(500);
      }
    }
    if (lastError) throw new Error(`postgres container never became ready: ${String(lastError)}`);

    pool = new pg.Pool({ connectionString });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    app = createApp(db);
    await signUp(USER_A);
    await signUp(USER_B);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    } catch {
      // Container already gone.
    }
  });

  it("upserts by (machine, harness, session) and derives status from the axes", async () => {
    const machine = await registerMachine(USER_A, "snapshot-upsert");

    const first = await put(
      USER_A,
      machine.id,
      snapshot([
        {
          harness: "claude",
          sessionId: "sess-working",
          cwd: "/Users/w/code/hitch",
          process: { pid: 48213, startedAt: 1753000000 },
          existence: "running",
          activity: "working",
          source: "claude-pidfile",
          evidence: { self: "busy", mtimeAge: 1.2 },
          handle: { cmux: "surface:7" },
        },
        {
          harness: "codex",
          sessionId: "sess-dormant",
          existence: "dormant",
          activity: "unknown",
        },
        {
          harness: "claude",
          sessionId: "sess-pending",
          existence: "pending",
          activity: "unknown",
        },
      ]),
    );
    expect(first.status).toBe(200);
    const firstBody = await json(first);
    expect(firstBody.upserted).toBe(3);
    expect(firstBody.dead).toBe(0);

    const byId = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(byId.get("sess-working").status).toBe("busy");
    expect(byId.get("sess-working").pid).toBe(48213);
    expect(byId.get("sess-working").processStartedAt).toBe(1753000000);
    // `source` is folded into the evidence jsonb.
    expect(byId.get("sess-working").evidence).toEqual({
      source: "claude-pidfile",
      self: "busy",
      mtimeAge: 1.2,
    });
    expect(byId.get("sess-working").handle).toEqual({ cmux: "surface:7" });
    // No title in the snapshot → placeholder derived from cwd + session id.
    expect(byId.get("sess-working").title).toBe("hitch (sess-wor)");
    // unknown activity resolves to idle, never busy.
    expect(byId.get("sess-dormant").status).toBe("idle");
    expect(byId.get("sess-pending").status).toBe("busy");

    const idBefore = byId.get("sess-working").id;

    // Second tick: same natural key updates in place, never inserts.
    const second = await put(
      USER_A,
      machine.id,
      snapshot([
        {
          harness: "claude",
          sessionId: "sess-working",
          existence: "running",
          activity: "idle",
          title: "A real title",
        },
        { harness: "codex", sessionId: "sess-dormant", existence: "dormant", activity: "unknown" },
        { harness: "claude", sessionId: "sess-pending", existence: "pending", activity: "unknown" },
      ]),
    );
    expect(second.status).toBe(200);
    const after = (await chatsOf(USER_A, machine.id)).find((c) => c.sessionId === "sess-working");
    expect(after.id).toBe(idBefore);
    expect(after.status).toBe("idle");
    expect(after.title).toBe("A real title");
    // Omitted fields are preserved, not wiped.
    expect(after.handle).toEqual({ cmux: "surface:7" });
    expect(after.cwd).toBe("/Users/w/code/hitch");

    // Same session id on a DIFFERENT harness is a different chat.
    const third = await put(
      USER_A,
      machine.id,
      snapshot([
        { harness: "claude", sessionId: "shared-id", existence: "running", activity: "idle" },
        { harness: "codex", sessionId: "shared-id", existence: "running", activity: "idle" },
      ]),
    );
    expect(third.status).toBe(200);
    expect((await json(third)).upserted).toBe(2);
    const shared = (await chatsOf(USER_A, machine.id)).filter((c) => c.sessionId === "shared-id");
    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((c) => c.harness))).toEqual(new Set(["claude", "codex"]));
  });

  it("marks absent chats dead on the FIRST miss — no second server-side debounce", async () => {
    const machine = await registerMachine(USER_A, "snapshot-sweep");
    const live = [
      { harness: "claude", sessionId: "sweep-a", existence: "running", activity: "working" },
      { harness: "claude", sessionId: "sweep-b", existence: "pending", activity: "unknown" },
      { harness: "codex", sessionId: "sweep-c", existence: "dormant", activity: "idle" },
    ];
    expect((await put(USER_A, machine.id, snapshot(live))).status).toBe(200);

    // One tick with sweep-a and sweep-b gone.
    const res = await put(USER_A, machine.id, snapshot([live[2]]));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.dead).toBe(2);

    const rows = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(rows.get("sweep-a").status).toBe("dead");
    expect(rows.get("sweep-a").existence).toBeNull();
    expect(rows.get("sweep-b").status).toBe("dead");
    // A dormant chat was never "live" in the sweep sense — it is not swept, and
    // it is still in the snapshot anyway.
    expect(rows.get("sweep-c").status).toBe("idle");

    // live=true hides the dead ones.
    const liveOnly = await json(
      await api(USER_A, "GET", `/chats?machine_id=${machine.id}&live=true`),
    );
    expect(liveOnly.map((c: any) => c.sessionId)).toEqual(["sweep-c"]);
  });

  it("skips the death sweep entirely when the window is truncated", async () => {
    const machine = await registerMachine(USER_A, "snapshot-truncated");
    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([
            { harness: "claude", sessionId: "trunc-a", existence: "running", activity: "working" },
            { harness: "claude", sessionId: "trunc-b", existence: "pending", activity: "unknown" },
          ]),
        )
      ).status,
    ).toBe(200);

    // Coverage was incomplete: absence proves nothing, so nothing dies.
    const res = await put(USER_A, machine.id, snapshot([], { truncated: true }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.truncated).toBe(true);
    expect(body.dead).toBe(0);

    const rows = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(rows.get("trunc-a").status).toBe("busy");
    expect(rows.get("trunc-a").existence).toBe("running");
    expect(rows.get("trunc-b").status).toBe("busy");

    // A complete empty snapshot, by contrast, kills both.
    const complete = await put(USER_A, machine.id, snapshot([]));
    expect((await json(complete)).dead).toBe(2);
    const after = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(after.get("trunc-a").status).toBe("dead");
    expect(after.get("trunc-b").status).toBe("dead");
  });

  it("lands relayed events and lets block.* drive the block column", async () => {
    const machine = await registerMachine(USER_A, "snapshot-events");
    const chat = {
      harness: "claude" as const,
      sessionId: "evt-1",
      existence: "running" as const,
      activity: "working" as const,
    };

    const raised = await put(
      USER_A,
      machine.id,
      snapshot([chat], {
        events: [
          {
            sessionId: "evt-1",
            kind: "block.permission",
            at: new Date().toISOString(),
            payload: { tool: "Bash" },
          },
          // An event for a chat we've never seen has no row to hang off.
          { sessionId: "ghost", kind: "block.permission", at: new Date().toISOString() },
        ],
      }),
    );
    expect(raised.status).toBe(200);
    const raisedBody = await json(raised);
    expect(raisedBody.events).toBe(1);
    expect(raisedBody.eventsDropped).toBe(1);

    let row = (await chatsOf(USER_A, machine.id))[0];
    expect(row.block).toBe("permission");
    // Working AND blocked — status shows the block, activity is untouched.
    expect(row.status).toBe("waiting_input");
    expect(row.activity).toBe("working");

    const stored = await pool.query(
      "select kind, payload from chat_events where chat_id = $1 order by at desc",
      [row.id],
    );
    expect(stored.rows).toEqual([{ kind: "block.permission", payload: { tool: "Bash" } }]);

    // A tick with no events preserves the block (events own the axis).
    expect((await put(USER_A, machine.id, snapshot([chat]))).status).toBe(200);
    row = (await chatsOf(USER_A, machine.id))[0];
    expect(row.block).toBe("permission");
    expect(row.status).toBe("waiting_input");

    // block.clear releases it.
    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([chat], {
            events: [{ sessionId: "evt-1", kind: "block.clear", at: new Date().toISOString() }],
          }),
        )
      ).status,
    ).toBe(200);
    row = (await chatsOf(USER_A, machine.id))[0];
    expect(row.block).toBeNull();
    expect(row.status).toBe("busy");

    // A non-block event is stored but changes nothing.
    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([chat], {
            events: [{ sessionId: "evt-1", kind: "turn.completed", at: new Date().toISOString() }],
          }),
        )
      ).status,
    ).toBe(200);
    row = (await chatsOf(USER_A, machine.id))[0];
    expect(row.block).toBeNull();
    const kinds = await pool.query("select kind from chat_events where chat_id = $1", [row.id]);
    expect(kinds.rows.map((r) => r.kind).sort()).toEqual([
      "block.clear",
      "block.permission",
      "turn.completed",
    ]);

    // The block dies with its process.
    expect((await put(USER_A, machine.id, snapshot([chat], { events: [{ sessionId: "evt-1", kind: "block.question", at: new Date().toISOString() }] }))).status).toBe(200);
    expect((await chatsOf(USER_A, machine.id))[0].block).toBe("question");
    expect((await put(USER_A, machine.id, snapshot([]))).status).toBe(200);
    row = (await chatsOf(USER_A, machine.id))[0];
    expect(row.status).toBe("dead");
    expect(row.block).toBeNull();
    // chat_events survive the death — they are the "why".
    const survived = await pool.query("select count(*)::int as n from chat_events where chat_id = $1", [
      row.id,
    ]);
    expect(survived.rows[0].n).toBe(4);
  });

  it("attaches a project via `task` (assignment id) and rejects unowned ids", async () => {
    const machine = await registerMachine(USER_A, "snapshot-attach");
    const project = await json(
      await api(USER_A, "POST", "/projects", { name: "Snapshot project", sortOrder: "a0" }),
    );
    const task = await json(
      await api(USER_A, "POST", "/tasks", { projectId: project.id, title: "t", sortOrder: "a0" }),
    );
    const assignment = await json(
      await api(USER_A, "POST", "/assignments", {
        taskId: task.id,
        machineId: machine.id,
        harness: "claude",
      }),
    );

    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([
            {
              harness: "claude",
              sessionId: "attach-1",
              existence: "running",
              activity: "idle",
              task: assignment.id,
            },
            // A found chat carries no attachment at all — still a valid chat.
            { harness: "codex", sessionId: "attach-2", existence: "running", activity: "idle" },
            // Someone else's project id resolves to no attachment, not a leak.
            {
              harness: "claude",
              sessionId: "attach-3",
              existence: "running",
              activity: "idle",
              projectId: "00000000-0000-7000-8000-0000000000ff",
            },
          ]),
        )
      ).status,
    ).toBe(200);

    const rows = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(rows.get("attach-1").projectId).toBe(project.id);
    expect(rows.get("attach-2").projectId).toBeNull();
    expect(rows.get("attach-3").projectId).toBeNull();
  });

  it("rejects a machine that isn't yours, and duplicate keys inside one snapshot", async () => {
    const machine = await registerMachine(USER_A, "snapshot-ownership");

    const stolen = await put(
      USER_B,
      machine.id,
      snapshot([{ harness: "claude", sessionId: "x", existence: "running", activity: "idle" }]),
    );
    expect(stolen.status).toBe(404);

    const dupe = await put(
      USER_A,
      machine.id,
      snapshot([
        { harness: "claude", sessionId: "dupe", existence: "running", activity: "idle" },
        { harness: "claude", sessionId: "dupe", existence: "dormant", activity: "idle" },
      ]),
    );
    expect(dupe.status).toBe(400);

    // And nothing was written.
    expect(await chatsOf(USER_A, machine.id)).toEqual([]);
  });

  it("scopes GET /chats to the signed-in user", async () => {
    const machineA = await registerMachine(USER_A, "snapshot-scope-a");
    const machineB = await registerMachine(USER_B, "snapshot-scope-b");
    await put(
      USER_A,
      machineA.id,
      snapshot([{ harness: "claude", sessionId: "mine", existence: "running", activity: "idle" }]),
    );
    await put(
      USER_B,
      machineB.id,
      snapshot([{ harness: "claude", sessionId: "theirs", existence: "running", activity: "idle" }]),
    );

    const aSessions = ((await json(await api(USER_A, "GET", "/chats"))) as any[]).map(
      (c) => c.sessionId,
    );
    expect(aSessions).toContain("mine");
    expect(aSessions).not.toContain("theirs");

    const bSessions = ((await json(await api(USER_B, "GET", "/chats"))) as any[]).map(
      (c) => c.sessionId,
    );
    expect(bSessions).toEqual(["theirs"]);

    // Filtering by someone else's machine yields nothing rather than a leak.
    const cross = await json(await api(USER_B, "GET", `/chats?machine_id=${machineA.id}`));
    expect(cross).toEqual([]);
  });

  it("keeps the legacy POST/PATCH /daemon/chats contract working (cmuxRef ⇄ handle)", async () => {
    const machine = await registerMachine(USER_A, "snapshot-legacy");

    const created = await api(USER_A, "POST", "/daemon/chats", {
      machineId: machine.id,
      projectId: null,
      harness: "claude",
      title: "legacy chat",
      cmuxRef: { localKey: "chat:claude-code:h:abc", sessionId: "abc" },
      status: "busy",
      lastActivityAt: new Date().toISOString(),
    });
    expect(created.status).toBe(201);
    const chat = await json(created);
    // The daemon reads `cmuxRef` off every chat it gets back — keep echoing it.
    expect(chat.cmuxRef).toEqual({ localKey: "chat:claude-code:h:abc", sessionId: "abc" });
    expect(chat.handle).toEqual(chat.cmuxRef);
    expect(chat.sessionId).toBeNull();

    const patched = await json(
      await api(USER_A, "PATCH", `/daemon/chats/${chat.id}`, {
        cmuxRef: { localKey: "chat:claude-code:h:abc", sessionId: "abc", bound: true },
        status: "idle",
      }),
    );
    expect(patched.status).toBe("idle");
    expect((patched.cmuxRef as any).bound).toBe(true);

    const listed = await json(await api(USER_A, "GET", `/daemon/chats?machine_id=${machine.id}`));
    expect(listed[0].cmuxRef).toEqual(patched.cmuxRef);

    // Legacy rows have no session_id; the unique index must tolerate several.
    const second = await api(USER_A, "POST", "/daemon/chats", {
      machineId: machine.id,
      harness: "claude",
      title: "legacy chat 2",
      cmuxRef: {},
      status: "busy",
    });
    expect(second.status).toBe(201);
  });
});
