import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { createApp } from "../app.js";
import * as schema from "../db/schema.js";
import { attachWebSocket, startChangeListener } from "../ws.js";

// Same throwaway-container harness as routes.test.ts, plus a REAL http server
// on an ephemeral port — @hono/node-ws hooks the node server's upgrade event,
// so app.request alone can't exercise the WS path. The `ws` package is the
// client because it can set headers (cookie / x-api-key) on the upgrade.
//
// NOT covered here: LISTEN-client reconnect/backoff (killing the connection
// under a live pg client is awkward to do cheaply in Docker) — that path is
// small and covered by manual review of startChangeListener in ws.ts.
let dockerError: string | null = null;
try {
  execSync("docker info", { stdio: "pipe" });
} catch (error) {
  dockerError = error instanceof Error ? error.message : String(error);
}

if (dockerError) {
  console.error(
    `[ws.test] SKIPPING: Docker is unreachable — start Docker Desktop and re-run.\n${dockerError}`,
  );
}

const describeDb = dockerError ? describe.skip : describe;

const CONTAINER_NAME = `hitch-ws-test-${process.pid}`;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

process.env.BETTER_AUTH_SECRET ??= "hitch-test-secret-do-not-use-in-prod";

const USER_A = "ws-user-a";
const USER_B = "ws-user-b";

type WsMessage = Record<string, unknown>;

type TestSocket = {
  ws: WebSocket;
  received: WsMessage[];
  /** Resolves with the first message (past or future) matching `pred`. */
  waitFor: (pred: (msg: WsMessage) => boolean, timeoutMs?: number) => Promise<WsMessage>;
};

describeDb("WS realtime layer (postgres:16 in Docker + live http server)", () => {
  let pool: pg.Pool;
  let server: ReturnType<typeof serve>;
  let port: number;
  let changeListener: Awaited<ReturnType<typeof startChangeListener>>;
  const openSockets: WebSocket[] = [];
  const cookies: Record<string, string> = {};

  const baseUrl = () => `http://127.0.0.1:${port}`;
  const wsUrl = () => `ws://127.0.0.1:${port}/ws`;

  const api = async (userKey: string, method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        cookie: cookies[userKey],
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const json = async (res: Response) => (await res.json()) as any;

  const signUp = async (key: string) => {
    const res = await fetch(`${baseUrl()}/api/auth/sign-up/email`, {
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

  const connectWs = (headers: Record<string, string>) =>
    new Promise<TestSocket>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(), { headers });
      openSockets.push(ws);
      const received: WsMessage[] = [];
      const waiters: Array<{ pred: (msg: WsMessage) => boolean; resolve: (m: WsMessage) => void }> =
        [];
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as WsMessage;
        received.push(msg);
        for (const waiter of [...waiters]) {
          if (waiter.pred(msg)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(msg);
          }
        }
      });
      const waitFor = (pred: (msg: WsMessage) => boolean, timeoutMs = 5000) => {
        const hit = received.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise<WsMessage>((resolveWait, rejectWait) => {
          const waiter = { pred, resolve: resolveWait };
          waiters.push(waiter);
          setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index === -1) return;
            waiters.splice(index, 1);
            rejectWait(new Error(`no matching WS message within ${timeoutMs}ms`));
          }, timeoutMs).unref();
        });
      };
      ws.on("open", () => resolve({ ws, received, waitFor }));
      ws.on("error", reject);
    });

  const send = (socket: TestSocket, msg: unknown) => socket.ws.send(JSON.stringify(msg));

  const createProject = async (userKey: string, name: string) => {
    const res = await api(userKey, "POST", "/projects", { name, sortOrder: "a0" });
    expect(res.status).toBe(201);
    return json(res);
  };

  const createTask = async (userKey: string, projectId: string, title: string) => {
    const res = await api(userKey, "POST", "/tasks", { projectId, title, sortOrder: "a0" });
    expect(res.status).toBe(201);
    return json(res);
  };

  const registerMachine = async (userKey: string, name: string) => {
    const res = await api(userKey, "POST", "/daemon/machines", {
      name,
      daemonVersion: "0.0.1-test",
    });
    expect(res.status).toBe(201);
    return json(res);
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
    const pgPort = portLine.split(":").pop();
    const connectionString = `postgres://postgres:hitch@127.0.0.1:${pgPort}/hitch`;

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
    if (lastError) {
      throw new Error(`postgres container never became ready: ${String(lastError)}`);
    }

    pool = new pg.Pool({ connectionString });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    const app = createApp(db);
    const { injectWebSocket, broadcastInvalidate } = attachWebSocket(app);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        port = info.port;
        resolve();
      });
    });
    injectWebSocket(server);

    changeListener = startChangeListener({ connectionString, onChange: broadcastInvalidate });
    await changeListener.ready;

    await signUp(USER_A);
    await signUp(USER_B);
  }, 120_000);

  afterAll(async () => {
    for (const ws of openSockets) ws.close();
    await changeListener?.stop();
    server?.close();
    await pool?.end();
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "pipe" });
    } catch {
      // Container already gone (e.g. startup failed) — nothing to clean up.
    }
  });

  it("rejects an unauthenticated upgrade with a 401", async () => {
    for (const headers of [undefined, { "x-api-key": "hitch-not-a-real-key-0000000000000000" }]) {
      const error = await new Promise<Error>((resolve) => {
        const ws = new WebSocket(wsUrl(), headers ? { headers } : undefined);
        ws.on("open", () => resolve(new Error("upgrade unexpectedly succeeded")));
        ws.on("error", resolve);
      });
      expect(String(error)).toContain("401");
    }
  });

  it("broadcasts {type:'invalidate', table:'tasks', id} to every connection on an HTTP task insert", async () => {
    const a = await connectWs({ cookie: cookies[USER_A] });
    const b = await connectWs({ cookie: cookies[USER_B] });

    const project = await createProject(USER_A, "WS project");
    const task = await createTask(USER_A, project.id, "notify me");

    const isTaskInvalidate = (m: WsMessage) =>
      m.type === "invalidate" && m.table === "tasks" && m.id === task.id;
    expect(await a.waitFor(isTaskInvalidate)).toEqual({
      type: "invalidate",
      table: "tasks",
      id: task.id,
    });
    // Deliberate v1 simplification: invalidations reach ALL users' connections
    // (table + uuid only; refetches are auth-scoped, nothing meaningful leaks).
    await b.waitFor(isTaskInvalidate);
  });

  it("forwards the task_tags composite payload ({task_id, tag_id}, no id)", async () => {
    const a = await connectWs({ cookie: cookies[USER_A] });

    const project = await createProject(USER_A, "Tag WS project");
    const task = await createTask(USER_A, project.id, "taggable");
    const tagRes = await api(USER_A, "POST", "/tags", { name: `ws-${randomUUID()}`, color: "olive" });
    expect(tagRes.status).toBe(201);
    const tag = await json(tagRes);

    const linkRes = await api(USER_A, "POST", `/tasks/${task.id}/tags/${tag.id}`);
    expect(linkRes.status).toBe(201);

    const msg = await a.waitFor(
      (m) => m.type === "invalidate" && m.table === "task_tags" && m.task_id === task.id,
    );
    expect(msg).toEqual({
      type: "invalidate",
      table: "task_tags",
      task_id: task.id,
      tag_id: tag.id,
    });
    expect(msg).not.toHaveProperty("id");
  });

  describe("ephemeral event relay", () => {
    // The hello has no ack (there is deliberately nothing to ack — the layer
    // is fire-and-forget), so tests re-send events until one lands instead of
    // sleeping and hoping the hello was processed. Re-sending is safe by
    // design: undelivered events evaporate.
    const relayUntilReceived = async (
      sender: TestSocket,
      receiver: TestSocket,
      machineId: string,
      payload: unknown,
    ) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        send(sender, { type: "event", event: "focus", machineId, payload });
        try {
          return await receiver.waitFor((m) => m.type === "event", 300);
        } catch {
          // Not yet — hello may still be in flight; try again.
        }
      }
      throw new Error("focus event never relayed");
    };

    it("relays a focus event to the connection hello'd for the machine, payload intact", async () => {
      const machine = await registerMachine(USER_A, "ws-relay-machine");
      const keyRes = await fetch(`${baseUrl()}/api/auth/api-key/create`, {
        method: "POST",
        headers: { cookie: cookies[USER_A], "content-type": "application/json" },
        body: JSON.stringify({ name: "ws-test-daemon-key" }),
      });
      expect(keyRes.status).toBe(200);
      const { key } = await json(keyRes);

      // A's daemon connection (api-key auth) registers for the machine; A's
      // client connection (cookie auth) addresses an event to it.
      const daemon = await connectWs({ "x-api-key": key });
      send(daemon, { type: "hello", machineId: machine.id });
      const client = await connectWs({ cookie: cookies[USER_A] });

      const payload = { taskId: randomUUID(), chatId: "chat-1" };
      const received = await relayUntilReceived(client, daemon, machine.id, payload);
      expect(received).toEqual({ type: "event", event: "focus", payload });
      // The relayed shape has no machineId — the daemon IS the machine.
      expect(received).not.toHaveProperty("machineId");
    });

    it("evaporates an event addressed to a machine with no hello'd connection", async () => {
      const lonely = await registerMachine(USER_A, "ws-lonely-machine");
      const client = await connectWs({ cookie: cookies[USER_A] });

      send(client, { type: "event", event: "focus", machineId: lonely.id, payload: { n: 1 } });
      await sleep(400);
      expect(client.received.filter((m) => m.type === "event")).toEqual([]);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
    });

    it("never relays across users: B can't address A's machine, and B's hello for it is ignored", async () => {
      const machine = await registerMachine(USER_A, "ws-crossuser-machine");
      const keyRes = await fetch(`${baseUrl()}/api/auth/api-key/create`, {
        method: "POST",
        headers: { cookie: cookies[USER_A], "content-type": "application/json" },
        body: JSON.stringify({ name: "ws-crossuser-daemon-key" }),
      });
      const { key } = await json(keyRes);

      const daemonA = await connectWs({ "x-api-key": key });
      send(daemonA, { type: "hello", machineId: machine.id });
      const clientA = await connectWs({ cookie: cookies[USER_A] });
      const intruderB = await connectWs({ cookie: cookies[USER_B] });

      // B hello'ing A's machine is ignored — B must never receive its events.
      send(intruderB, { type: "hello", machineId: machine.id });
      // B addressing A's machine is dropped before the registry is consulted.
      send(intruderB, { type: "event", event: "focus", machineId: machine.id, payload: { evil: true } });

      // A's own relay still works; only daemonA sees it.
      const payload = { taskId: randomUUID() };
      const received = await relayUntilReceived(clientA, daemonA, machine.id, payload);
      expect(received).toEqual({ type: "event", event: "focus", payload });
      expect(daemonA.received.filter((m) => (m.payload as any)?.evil)).toEqual([]);
      expect(intruderB.received.filter((m) => m.type === "event")).toEqual([]);
    });
  });
});
