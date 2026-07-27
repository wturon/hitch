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

  it("links an existing live chat idempotently and rejects conflicting live work", async () => {
    const machine = await registerMachine(USER_A, "link-existing");
    const project = await json(
      await api(USER_A, "POST", "/projects", { name: "Link project", sortOrder: "a0" }),
    );
    const taskA = await json(
      await api(USER_A, "POST", "/tasks", {
        projectId: project.id,
        title: "Task A",
        sortOrder: "a0",
      }),
    );
    const taskB = await json(
      await api(USER_A, "POST", "/tasks", {
        projectId: project.id,
        title: "Task B",
        sortOrder: "a1",
      }),
    );
    const live = [
      { harness: "codex", sessionId: "link-one", existence: "running", activity: "working" },
      { harness: "codex", sessionId: "link-two", existence: "running", activity: "idle" },
    ];
    expect((await put(USER_A, machine.id, snapshot(live))).status).toBe(200);
    const chats = new Map((await chatsOf(USER_A, machine.id)).map((chat) => [chat.sessionId, chat]));

    const linkBody = {
      taskId: taskA.id,
      harness: "codex",
      sessionId: "link-one",
    };
    const [first, raced] = await Promise.all([
      api(USER_A, "POST", "/assignments/link", linkBody),
      api(USER_A, "POST", "/assignments/link", linkBody),
    ]);
    expect([first.status, raced.status].sort()).toEqual([200, 201]);
    const [assignment, racedAssignment] = await Promise.all([json(first), json(raced)]);
    expect(racedAssignment.id).toBe(assignment.id);
    expect(assignment).toMatchObject({
      taskId: taskA.id,
      machineId: machine.id,
      harness: "codex",
      requestedChatId: chats.get("link-one").id,
      chatId: null,
      prompt: null,
      desiredState: "running",
      observedState: "pending",
    });

    // Same pair remains a read-like retry after the concurrent race.
    const again = await api(USER_A, "POST", "/assignments/link", {
      taskId: taskA.id,
      harness: "codex",
      sessionId: "link-one",
    });
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(assignment.id);

    // Neither side of an active pairing can be silently reassigned.
    const chatConflict = await api(USER_A, "POST", "/assignments/link", {
      taskId: taskB.id,
      harness: "codex",
      sessionId: "link-one",
    });
    expect(chatConflict.status).toBe(409);
    expect((await json(chatConflict)).error).toContain("chat is already linked");

    const taskConflict = await api(USER_A, "POST", "/assignments/link", {
      taskId: taskA.id,
      harness: "codex",
      sessionId: "link-two",
    });
    expect(taskConflict.status).toBe(409);
    expect((await json(taskConflict)).error).toContain("task already has");

    // A user cannot resolve another user's chat by its harness-native id.
    const otherProject = await json(
      await api(USER_B, "POST", "/projects", { name: "Other", sortOrder: "a0" }),
    );
    const otherTask = await json(
      await api(USER_B, "POST", "/tasks", {
        projectId: otherProject.id,
        title: "Other task",
        sortOrder: "a0",
      }),
    );
    const stolen = await api(USER_B, "POST", "/assignments/link", {
      taskId: otherTask.id,
      harness: "codex",
      sessionId: "link-one",
    });
    expect(stolen.status).toBe(404);

    // The request cannot silently disappear and turn pending intent into a
    // spawn. Historical chat rows are protected while an assignment targets
    // them.
    await expect(
      pool.query("delete from chats where id = $1", [chats.get("link-one").id]),
    ).rejects.toThrow();
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

  it("clears existence but NOT status when a dormant chat ages out of the window", async () => {
    const machine = await registerMachine(USER_A, "snapshot-aged-out");
    const live = [
      { harness: "claude", sessionId: "age-live", existence: "running", activity: "working" },
      { harness: "claude", sessionId: "age-old", existence: "dormant", activity: "idle" },
    ];
    expect((await put(USER_A, machine.id, snapshot(live))).status).toBe(200);
    const before = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(before.get("age-old").existence).toBe("dormant");

    // age-old's transcript ages past the 24h window: the daemon simply stops
    // reporting it. That is NOT a death — we stopped looking, and it is still
    // resumable.
    const res = await put(USER_A, machine.id, snapshot([live[0]]));
    const body = await json(res);
    expect(body.dead).toBe(0);
    expect(body.agedOut).toBe(1);

    const after = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    // Existence is machine-owned, and the machine is no longer asserting it.
    expect(after.get("age-old").existence).toBeNull();
    // …but the verdict it carried is history, and history survives.
    expect(after.get("age-old").status).toBe("idle");
    // Never restamped: "last seen" must keep meaning the last real sighting,
    // which is what lets a reader say "absent, last seen 46m ago".
    expect(after.get("age-old").lastObservedAt).toBe(before.get("age-old").lastObservedAt);
    // It stays resumable, so `live` still lists it — only `dead` is terminal.
    const liveOnly = await json(
      await api(USER_A, "GET", `/chats?machine_id=${machine.id}&live=true`),
    );
    expect(liveOnly.map((c: any) => c.sessionId).sort()).toEqual(["age-live", "age-old"]);

    // And it does not re-clear on every later tick — one transition, then quiet.
    const again = await json(await put(USER_A, machine.id, snapshot([live[0]])));
    expect(again.agedOut).toBe(0);
  });

  it("resurrects an aged-out chat when its transcript re-enters the window", async () => {
    const machine = await registerMachine(USER_A, "snapshot-resurrect");
    const dormant = {
      harness: "claude",
      sessionId: "res-1",
      existence: "dormant",
      activity: "idle",
    };
    expect((await put(USER_A, machine.id, snapshot([dormant]))).status).toBe(200);
    expect((await json(await put(USER_A, machine.id, snapshot([])))).agedOut).toBe(1);

    // Resuming it pulls it back into the window (§5.3) — the row is the same
    // row, and it simply starts carrying an existence again.
    await put(
      USER_A,
      machine.id,
      snapshot([{ ...dormant, existence: "running", activity: "working" }]),
    );
    const row = (await chatsOf(USER_A, machine.id)).find((c) => c.sessionId === "res-1");
    expect(row.existence).toBe("running");
    expect(row.status).toBe("busy");
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

  it("attaches events by (harness, sessionId), and drops an ambiguous one rather than guessing", async () => {
    const machine = await registerMachine(USER_A, "snapshot-event-key");
    // The same session id under both harnesses — two distinct chats, per the
    // unique index. Vanishingly unlikely in the field (different id
    // generators), but the wire contract must not depend on that.
    const claude = {
      harness: "claude" as const,
      sessionId: "collide",
      existence: "running" as const,
      activity: "working" as const,
    };
    const codex = { ...claude, harness: "codex" as const };

    const res = await put(
      USER_A,
      machine.id,
      snapshot([claude, codex], {
        events: [
          // Fully keyed → lands on the codex chat only.
          {
            sessionId: "collide",
            harness: "codex",
            kind: "block.permission",
            at: new Date().toISOString(),
            payload: { which: "codex" },
          },
          // No harness, two candidates → ambiguous, dropped.
          { sessionId: "collide", kind: "block.question", at: new Date().toISOString() },
          // Harness that has no such session → dropped, not silently retargeted.
          {
            sessionId: "collide",
            harness: "claude",
            kind: "turn.completed",
            at: new Date().toISOString(),
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.upserted).toBe(2);
    // 1 landed (codex block), 1 ambiguous, 1 valid claude event — the claude
    // chat exists, so that third event lands too.
    expect(body.events).toBe(2);
    expect(body.eventsDropped).toBe(1);

    const rows = new Map(
      (await chatsOf(USER_A, machine.id)).map((c) => [c.harness, c] as [string, any]),
    );
    // The block went to codex and ONLY codex.
    expect(rows.get("codex").block).toBe("permission");
    expect(rows.get("codex").status).toBe("waiting_input");
    expect(rows.get("claude").block).toBeNull();
    expect(rows.get("claude").status).toBe("busy");

    // Each chat's event tail holds only its own events.
    const codexEvents = await pool.query(
      "select kind, payload from chat_events where chat_id = $1",
      [rows.get("codex").id],
    );
    expect(codexEvents.rows).toEqual([{ kind: "block.permission", payload: { which: "codex" } }]);
    const claudeEvents = await pool.query("select kind from chat_events where chat_id = $1", [
      rows.get("claude").id,
    ]);
    expect(claudeEvents.rows.map((r) => r.kind)).toEqual(["turn.completed"]);

    // With only ONE harness holding the id, a harness-less event resolves
    // unambiguously — an older daemon keeps working.
    const machine2 = await registerMachine(USER_A, "snapshot-event-key-solo");
    expect(
      (
        await put(
          USER_A,
          machine2.id,
          snapshot([claude], {
            events: [
              { sessionId: "collide", kind: "block.question", at: new Date().toISOString() },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const solo = (await chatsOf(USER_A, machine2.id))[0];
    expect(solo.harness).toBe("claude");
    expect(solo.block).toBe("question");
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

  // --- the Chat Inspector's reads (docs/chat-tracking-redesign.md §9) --------

  it("records the snapshot's COVERAGE on the machine, including a truncated tick", async () => {
    const machine = await registerMachine(USER_A, "snapshot-coverage");
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const observedAt = new Date().toISOString();

    expect(
      (
        await put(USER_A, machine.id, {
          observedAt,
          window: { since, cap: 60, truncated: false },
          chats: [{ harness: "claude", sessionId: "cov-1", existence: "running", activity: "idle" }],
          events: [],
        })
      ).status,
    ).toBe(200);

    const machinesOf = async (userKey: string) =>
      (await json(await api(userKey, "GET", "/machines"))) as any[];
    let row = (await machinesOf(USER_A)).find((m) => m.id === machine.id);
    expect(new Date(row.chatSnapshotAt).toISOString()).toBe(observedAt);
    expect(new Date(row.chatWindowSince).toISOString()).toBe(since);
    expect(row.chatWindowCap).toBe(60);
    expect(row.chatWindowTruncated).toBe(false);

    // A truncated tick says so — the health strip's whole job is to make an
    // incomplete snapshot visible before anyone trusts the rows under it.
    expect(
      (
        await put(USER_A, machine.id, {
          observedAt: new Date().toISOString(),
          window: { since, cap: 40, truncated: true },
          chats: [],
          events: [],
        })
      ).status,
    ).toBe(200);
    row = (await machinesOf(USER_A)).find((m) => m.id === machine.id);
    expect(row.chatWindowTruncated).toBe(true);
    expect(row.chatWindowCap).toBe(40);
    // …and the truncated tick still skipped the sweep, so cov-1 lives.
    expect((await chatsOf(USER_A, machine.id)).map((c) => c.sessionId)).toEqual(["cov-1"]);
  });

  it("GET /chats carries the machine, project and task a row is attached to", async () => {
    const machine = await registerMachine(USER_A, "snapshot-attachnames");
    const project = await json(
      await api(USER_A, "POST", "/projects", { name: "Inspector project", sortOrder: "a0" }),
    );
    const task = await json(
      await api(USER_A, "POST", "/tasks", {
        projectId: project.id,
        title: "Wire the inspector",
        sortOrder: "a0",
      }),
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
            { harness: "claude", sessionId: "named-1", existence: "running", activity: "idle" },
            { harness: "codex", sessionId: "named-2", existence: "running", activity: "idle" },
          ]),
        )
      ).status,
    ).toBe(200);

    const rows = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    // Bind the assignment to the chat the way the daemon does (observation PATCH).
    expect(
      (
        await api(USER_A, "PATCH", `/daemon/assignments/${assignment.id}`, {
          chatId: rows.get("named-1").id,
        })
      ).status,
    ).toBe(200);
    // …and give named-1 a direct project attachment too.
    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([
            {
              harness: "claude",
              sessionId: "named-1",
              existence: "running",
              activity: "idle",
              projectId: project.id,
            },
            { harness: "codex", sessionId: "named-2", existence: "running", activity: "idle" },
          ]),
        )
      ).status,
    ).toBe(200);

    const named = new Map((await chatsOf(USER_A, machine.id)).map((c) => [c.sessionId, c]));
    expect(named.get("named-1").machineName).toBe("snapshot-attachnames");
    expect(named.get("named-1").projectName).toBe("Inspector project");
    expect(named.get("named-1").task).toEqual({
      id: task.id,
      title: "Wire the inspector",
      assignmentId: assignment.id,
    });
    // An unattached chat is a complete, correct chat — nulls, not omissions.
    expect(named.get("named-2").projectName).toBeNull();
    expect(named.get("named-2").task).toBeNull();
    expect(named.get("named-2").machineName).toBe("snapshot-attachnames");
  });

  it("serves a per-chat event tail, newest first, scoped to the owner", async () => {
    const machine = await registerMachine(USER_A, "snapshot-tail");
    const chat = {
      harness: "claude" as const,
      sessionId: "tail-1",
      existence: "running" as const,
      activity: "working" as const,
    };
    const t = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([chat], {
            events: [
              { sessionId: "tail-1", kind: "block.permission", at: t(30), payload: { tool: "Bash" } },
              { sessionId: "tail-1", kind: "block.clear", at: t(10) },
              { sessionId: "tail-1", kind: "turn.completed", at: t(50) },
            ],
          }),
        )
      ).status,
    ).toBe(200);

    const row = (await chatsOf(USER_A, machine.id))[0];
    const tail = (await json(await api(USER_A, "GET", `/chats/${row.id}/events`))) as any[];
    expect(tail.map((e) => e.kind)).toEqual(["block.clear", "block.permission", "turn.completed"]);
    expect(tail[1].payload).toEqual({ tool: "Bash" });

    // Bounded, and the bound is honoured.
    const capped = (await json(await api(USER_A, "GET", `/chats/${row.id}/events?limit=1`))) as any[];
    expect(capped.map((e) => e.kind)).toEqual(["block.clear"]);
    expect((await api(USER_A, "GET", `/chats/${row.id}/events?limit=0`)).status).toBe(400);

    // Someone else's chat is a 404, not a leak.
    expect((await api(USER_B, "GET", `/chats/${row.id}/events`)).status).toBe(404);
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

  // The legacy chat writers are GONE (phase D). They existed so the daemon
  // could create a chat row at spawn, before the snapshot pipeline could; the
  // daemon now pre-registers through the snapshot itself. What replaced them is
  // asserted below — this just pins that there is exactly ONE writer of chats.
  it("has no chat writer other than the snapshot PUT", async () => {
    const machine = await registerMachine(USER_A, "no-legacy-writer");

    const posted = await api(USER_A, "POST", "/daemon/chats", {
      machineId: machine.id,
      harness: "claude",
      title: "legacy chat",
      cmuxRef: { sessionId: "abc" },
      status: "busy",
    });
    expect(posted.status).toBe(404);

    const patched = await api(USER_A, "PATCH", "/daemon/chats/00000000-0000-7000-8000-000000000000", {
      status: "idle",
    });
    expect(patched.status).toBe(404);

    // The read the daemon still needs stays, and no longer carries the
    // `cmuxRef` back-compat alias — `handle` is the field.
    expect(
      (
        await put(
          USER_A,
          machine.id,
          snapshot([
            {
              harness: "claude",
              sessionId: "read-me",
              existence: "running",
              activity: "idle",
              handle: { kind: "cmux", sessionId: "read-me" },
            },
          ]),
        )
      ).status,
    ).toBe(200);
    const listed = await json(await api(USER_A, "GET", `/daemon/chats?machine_id=${machine.id}`));
    expect(listed).toHaveLength(1);
    expect(listed[0].handle).toEqual({ kind: "cmux", sessionId: "read-me" });
    expect(listed[0].cmuxRef).toBeUndefined();
  });

  // The phase-D spawn path, end to end on the server side. This is what the
  // deleted "legacy POST and snapshot converge on one row" test was really
  // protecting: one chat must stay ONE row across the moment the machine takes
  // over from the launcher.
  it("pre-registers a launch as `pending` and lets discovery land on the same row", async () => {
    const machine = await registerMachine(USER_A, "preregistration");
    const project = await json(
      await api(USER_A, "POST", "/projects", { name: "Spawn", sortOrder: "a0" }),
    );
    const task = await json(
      await api(USER_A, "POST", "/tasks", {
        projectId: project.id,
        title: "Delegated",
        body: "",
        sortOrder: "a0",
      }),
    );
    const assignment = await json(
      await api(USER_A, "POST", "/assignments", {
        taskId: task.id,
        machineId: machine.id,
        harness: "claude",
        desiredState: "running",
      }),
    );

    // 1. The launcher pinned the session id; the daemon pre-registers it in the
    //    very next snapshot, carrying both attachments.
    const created = await put(
      USER_A,
      machine.id,
      snapshot([
        {
          harness: "claude",
          sessionId: "spawn-1",
          cwd: "/repo",
          existence: "pending",
          activity: "unknown",
          source: "launch-pending",
          task: assignment.id,
          handle: { kind: "cmux", sessionId: "spawn-1", cwd: "/repo" },
          title: "Delegated",
        },
      ]),
    );
    expect(created.status).toBe(200);
    const pending = (await json(created)).chats[0];
    // `pending` is busy: it is spawning. And the echoed row is how the daemon
    // learns the chat id it must link the assignment to.
    expect(pending.status).toBe("busy");
    expect(pending.existence).toBe("pending");
    expect(pending.projectId).toBe(project.id);
    expect(pending.handle).toEqual({ kind: "cmux", sessionId: "spawn-1", cwd: "/repo" });

    // 2. A moment later the observer discovers the real process. Same natural
    //    key → same row, axes now owned by the machine.
    const discovered = await put(
      USER_A,
      machine.id,
      snapshot([
        {
          harness: "claude",
          sessionId: "spawn-1",
          cwd: "/repo",
          process: { pid: 4242, startedAt: 1753000000 },
          existence: "running",
          activity: "working",
          source: "claude-pidfile",
          task: assignment.id,
          handle: { kind: "cmux", sessionId: "spawn-1", cwd: "/repo" },
        },
      ]),
    );
    expect(discovered.status).toBe(200);
    const rows = (await chatsOf(USER_A, machine.id)).filter((c) => c.sessionId === "spawn-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(pending.id);
    expect(rows[0].status).toBe("busy");
    expect(rows[0].existence).toBe("running");
    expect(rows[0].pid).toBe(4242);
    // Neither attachment was disturbed by the handover.
    expect(rows[0].handle).toEqual({ kind: "cmux", sessionId: "spawn-1", cwd: "/repo" });
    expect(rows[0].title).toBe("Delegated");

    // 3. The tab closes: the chat leaves the snapshot and the sweep calls it.
    expect((await put(USER_A, machine.id, snapshot([]))).status).toBe(200);
    const dead = (await chatsOf(USER_A, machine.id)).find((c) => c.sessionId === "spawn-1");
    expect(dead.status).toBe("dead");
    expect(dead.existence).toBeNull();
  });
});
