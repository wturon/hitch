// V2 chat-relay integration test against the compose stack.
//
// Prereqs: the self-host compose stack is up and reachable at HITCH_SERVER_URL
// (default http://localhost:3010). Bring it up with `docker compose up -d
// --build` from the repo root first (see this file's npm script wrapper, which
// does it for you).
//
// What it proves (PR 2 acceptance), driving the shared store the way the
// observer would (writing rows directly — no real cmux):
//   1. A discovered chat with a project-mapped cwd appears on the server with
//      the right status (busy) and project.
//   2. Status transitions relay: busy → waiting_input → dead (endedAt).
//   3. V1's Convex `dirty` flag is untouched by the V2 server sync.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { DaemonLifecycleProducer } from "../src/chatLifecycleProducers.js";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type { ObservationRecord } from "../src/chatLifecycleStore.js";
import { startHitchDaemonV2 } from "../src/v2/daemonV2.js";
import { createServerClient } from "../src/v2/serverClient.js";

const SERVER_URL = (process.env.HITCH_SERVER_URL ?? "http://localhost:3010").replace(/\/+$/, "");
const HOST = hostname();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signUpAndKey(): Promise<string> {
  const email = `daemon-relay-${Date.now()}@test.local`;
  const password = "an-integration-test-password";
  const signUp = await fetch(`${SERVER_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SERVER_URL },
    body: JSON.stringify({ name: "relay-test", email, password }),
  });
  if (signUp.status !== 200) {
    throw new Error(`sign-up failed: ${signUp.status} ${await signUp.text()}`);
  }
  const cookie = (signUp.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("sign-up returned no session cookie");

  const keyRes = await fetch(`${SERVER_URL}/api/auth/api-key/create`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: SERVER_URL },
    body: JSON.stringify({ name: "relay-test-daemon" }),
  });
  if (keyRes.status !== 200) {
    throw new Error(`api-key create failed: ${keyRes.status} ${await keyRes.text()}`);
  }
  const { key } = (await keyRes.json()) as { key: string };
  if (!key) throw new Error("api-key create returned no key");
  return key;
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${SERVER_URL}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error(`server never became healthy at ${SERVER_URL}`);
}

function observation(
  chatId: string,
  projectId: string,
  cwd: string,
  overrides: Partial<ObservationRecord> = {},
): ObservationRecord {
  return {
    harness: "claude-code",
    chatId,
    host: HOST,
    cwd,
    projectId,
    environment: "cmux",
    existence: "running",
    activity: "working",
    source: "claude-pidfile",
    status: "working",
    title: "Integration relay chat",
    observedAt: Date.now(),
    evidence: null,
    endedAt: null,
    ...overrides,
  };
}

async function main(): Promise<void> {
  await waitForHealth();
  const apiKey = await signUpAndKey();
  const client = createServerClient(SERVER_URL, apiKey);

  // A scratch checkout the project's repo_path points at, and an isolated store
  // dir so we never touch the real Hitch app-support DB.
  const repoDir = mkdtempSync(join(tmpdir(), "hitch-relay-repo-"));
  const storeDir = mkdtempSync(join(tmpdir(), "hitch-relay-store-"));

  // Project with repo_path → the observer's cwd map picks this up on refresh.
  const projRes = await client.projects.$post({
    json: { name: "Relay Test", sortOrder: "a0", repoPath: repoDir },
  });
  assert.equal(projRes.status, 201, "project created");
  const project = (await projRes.json()) as { id: string };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HITCH_SERVER_URL: SERVER_URL,
    HITCH_API_KEY: apiKey,
    HITCH_APP_SUPPORT_DIR: storeDir,
    HITCH_HEARTBEAT_MS: "1000",
  };

  const daemon = await startHitchDaemonV2({
    env,
    envFiles: [],
    logger: { info: (m) => console.log(m), error: (m) => console.error(m) },
  });
  const machineId = daemon.machineId;

  // Second handle on the SAME sqlite DB the daemon opened (WAL allows this),
  // exactly how a V1 daemon would share the store. This is our stand-in for the
  // observer: we write rows the observer would have written.
  const store = openChatLifecycleStore({ appSupportDir: storeDir });
  const chatId = `relay-chat-${Date.now()}`;
  const localKey = `chat:claude-code:${HOST}:${chatId}`;
  const chatCwd = join(repoDir, "sub");

  async function serverChat(): Promise<{ id: string; status: string; projectId: string | null } | null> {
    const res = await client.daemon.chats.$get({ query: { machine_id: machineId } });
    assert.equal(res.ok, true, "GET /daemon/chats ok");
    const rows = (await res.json()) as Array<{
      id: string;
      status: string;
      projectId: string | null;
      cmuxRef: unknown;
    }>;
    return rows.find((r) => (r.cmuxRef as { localKey?: string })?.localKey === localKey) ?? null;
  }

  async function waitFor(
    predicate: (c: Awaited<ReturnType<typeof serverChat>>) => boolean,
    label: string,
  ): Promise<Awaited<ReturnType<typeof serverChat>>> {
    for (let i = 0; i < 20; i += 1) {
      const c = await serverChat();
      if (predicate(c)) return c;
      await sleep(500);
    }
    throw new Error(`timed out waiting for: ${label}`);
  }

  try {
    // 1. Discover → busy, project-mapped.
    store.recordObservation(observation(chatId, project.id, chatCwd));
    const busy = await waitFor((c) => c?.status === "busy", "chat to appear as busy");
    assert.equal(busy?.projectId, project.id, "server chat mapped to the project");
    console.log(`  ✓ chat relayed as busy, project=${busy?.projectId}`);

    // 2a. busy → waiting_input.
    store.recordObservation(
      observation(chatId, project.id, chatCwd, {
        activity: "idle",
        status: "waiting",
        observedAt: Date.now(),
      }),
    );
    await waitFor((c) => c?.status === "waiting_input", "chat to become waiting_input");
    console.log("  ✓ transitioned busy → waiting_input");

    // 2b. waiting_input → dead, via a session.ended event the daemon's reduce
    // loop folds in (sets endedAt → dead). Uses the producer, like the heal path.
    const producer = new DaemonLifecycleProducer({
      store,
      projectId: project.id,
      projectLocalPath: repoDir,
      host: HOST,
    });
    producer.sessionEnded({ harness: "claude-code", cwd: chatCwd, chatId, pid: null });
    await waitFor((c) => c?.status === "dead", "chat to become dead");
    console.log("  ✓ transitioned waiting_input → dead (endedAt)");

    // 3. V1 Convex `dirty` flag is set (the observation dirtied it) and the V2
    // sink never cleared it — the two sinks are independent.
    const row = store.getLocalChat(localKey);
    assert.equal(row?.dirty, true, "V1 Convex dirty flag untouched by V2 sync");
    assert.ok(row?.serverChatId, "server id mapping persisted on the row");
    assert.ok((row?.serverSyncedAt ?? 0) > 0, "server_synced_at recorded");
    console.log(`  ✓ V1 dirty flag intact; serverChatId=${row?.serverChatId}`);

    console.log("v2-chat-relay integration: OK");
  } finally {
    store.close();
    await daemon.stop();
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(storeDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
