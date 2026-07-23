import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type { ObservationRecord } from "../src/chatLifecycleStore.js";
import {
  ChatSync,
  isPermanentReject,
  isRepresentable,
} from "../src/v2/chatSync.js";
import type { HitchClient } from "../src/v2/serverClient.js";

// M4 PR 7 — the legacy-chat 400-storm fix.
//
// On a real machine the chat relay tried to sync ~720 legacy V1 chats whose
// projectId is a Convex document id (not a server UUID). The server's chatCreate
// validator rejects those with a 400, and because a failed push never cleared
// the sync cursor, every one of them re-POSTed (and re-400'd) every sync round —
// a permanent storm. This smoke reproduces the failure shape and pins the fix:
//   1. proactive: a non-UUID projectId row is skipped WITHOUT a network call.
//   2. backstop:  a representable row the server still 4xx-rejects is marked
//      synced and skipped so it can't storm either.
//   3. permanence: neither re-lists across a second sync round OR a restart.

const UUID = "11111111-1111-4111-8111-111111111111";
const CONVEX_ID = "m17brnqs30pyevfc05dp3r3x4s87z3an"; // real legacy shape
const HOST = "host-1";

// --- pure predicate coverage -------------------------------------------------
assert.equal(isRepresentable({ projectId: null }), true, "null projectId is representable");
assert.equal(isRepresentable({ projectId: UUID }), true, "uuid projectId is representable");
assert.equal(
  isRepresentable({ projectId: CONVEX_ID }),
  false,
  "a Convex-id projectId is NOT representable (the legacy 400 shape)",
);

assert.equal(isPermanentReject(400), true, "400 is non-retryable");
assert.equal(isPermanentReject(409), true, "409 conflict is non-retryable");
assert.equal(isPermanentReject(422), true, "422 is non-retryable");
assert.equal(isPermanentReject(401), false, "401 (rotated key) stays retryable");
assert.equal(isPermanentReject(403), false, "403 stays retryable");
assert.equal(isPermanentReject(404), false, "404 has its own recreate path");
assert.equal(isPermanentReject(429), false, "429 rate-limit stays retryable");
assert.equal(isPermanentReject(500), false, "5xx stays retryable");

// --- fake server -------------------------------------------------------------
// Simulates the real POST /daemon/chats: a non-UUID projectId 400s (z.uuid
// reject), and any chat we explicitly mark "rejectme" (by cmux_ref.sessionId)
// 400s too — standing in for an unforeseen unrepresentable shape.
function resp(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  };
}

const isUuid = (v: unknown): boolean =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const postCalls: Array<{ projectId: string | null; sessionId: unknown }> = [];
let nextServerId = 1;

const fakeClient = {
  daemon: {
    chats: {
      $post: async (input: {
        json: { projectId: string | null; cmuxRef: { sessionId?: unknown } };
      }) => {
        const { projectId, cmuxRef } = input.json;
        postCalls.push({ projectId, sessionId: cmuxRef?.sessionId });
        // The real server 400s a non-UUID projectId. The proactive guard should
        // mean this branch is NEVER hit for a legacy row — asserted below.
        if (projectId != null && !isUuid(projectId)) {
          return resp(400, JSON.stringify({ error: "projectId: invalid uuid" }));
        }
        if (cmuxRef?.sessionId === "rejectme-1") {
          return resp(400, JSON.stringify({ error: "unforeseen bad shape" }));
        }
        return resp(201, JSON.stringify({ id: `srv-${nextServerId++}` }));
      },
      ":id": {
        $patch: async () => resp(200, "{}"),
      },
    },
  },
} as unknown as HitchClient;

const logs: string[] = [];
const logger = {
  info: (m: string) => logs.push(m),
  error: (m: string) => logs.push(m),
};

function observation(
  chatId: string,
  projectId: string | null,
): ObservationRecord {
  return {
    harness: "claude-code",
    chatId,
    host: HOST,
    cwd: "/tmp/project",
    projectId,
    environment: null,
    existence: "running",
    activity: "working",
    source: "claude-pidfile",
    status: "working",
    title: null,
    observedAt: 1_800_000_000_000,
    evidence: null,
    endedAt: null,
  };
}

const dir = mkdtempSync(join(tmpdir(), "hitch-v2-legacy-skip-"));
try {
  const store = openChatLifecycleStore({ appSupportDir: dir });

  // Three rows: a legacy Convex-id chat (proactive skip), a representable chat
  // the server still rejects (backstop skip), and a healthy V2 chat (syncs).
  store.recordObservation(observation("legacy-1", CONVEX_ID));
  store.recordObservation(observation("rejectme-1", UUID));
  store.recordObservation(observation("good-1", UUID));

  const legacyKey = `chat:claude-code:${HOST}:legacy-1`;
  const rejectKey = `chat:claude-code:${HOST}:rejectme-1`;
  const goodKey = `chat:claude-code:${HOST}:good-1`;

  assert.equal(store.listServerDirtyChats().length, 3, "all three start server-dirty");

  const chatSync = new ChatSync({ store, client: fakeClient, machineId: UUID, logger });

  // --- round 1 ---------------------------------------------------------------
  const r1 = await chatSync.sync();
  assert.equal(r1.created, 1, "only the healthy row is created");
  assert.equal(r1.updated, 0);
  assert.equal(r1.failed, 0, "no failures — the 400s are skips, not retries");
  assert.equal(r1.skipped, 2, "the legacy row + the rejected row are both skipped");

  // The legacy row NEVER touched the wire (proactive representability guard).
  assert.ok(
    postCalls.every((c) => c.projectId == null || isUuid(c.projectId)),
    "no POST ever carried a non-UUID projectId (legacy row skipped before network)",
  );
  assert.ok(
    !postCalls.some((c) => c.sessionId === "legacy-1"),
    "the legacy chat was never POSTed",
  );
  const postCountAfterR1 = postCalls.length;
  assert.equal(postCountAfterR1, 2, "exactly the good + rejectme rows were POSTed");

  // All three are now off the dirty set (created OR permanently skipped).
  assert.equal(store.listServerDirtyChats().length, 0, "nothing left server-dirty after round 1");
  assert.equal(store.getLocalChat(goodKey)?.serverChatId, "srv-1", "good row got its server id");
  assert.notEqual(store.getLocalChat(legacyKey)?.serverSyncedAt, null, "legacy row marked synced");
  assert.notEqual(store.getLocalChat(rejectKey)?.serverSyncedAt, null, "rejected row marked synced");

  // --- round 2 (no state change) — zero repeated 400s ------------------------
  const r2 = await chatSync.sync();
  assert.deepEqual(
    r2,
    { created: 0, updated: 0, failed: 0, skipped: 0 },
    "round 2 does nothing — the storm is gone",
  );
  assert.equal(postCalls.length, postCountAfterR1, "round 2 made ZERO new POSTs");

  store.close();

  // --- restart (reopen the same store dir) — skip persists -------------------
  const restarted = openChatLifecycleStore({ appSupportDir: dir });
  assert.equal(
    restarted.listServerDirtyChats().length,
    0,
    "after a daemon restart the skipped rows are STILL not server-dirty",
  );
  const chatSync2 = new ChatSync({ store: restarted, client: fakeClient, machineId: UUID, logger });
  const r3 = await chatSync2.sync();
  assert.deepEqual(
    r3,
    { created: 0, updated: 0, failed: 0, skipped: 0 },
    "post-restart sync is a no-op — permanent skip survives a restart",
  );
  assert.equal(postCalls.length, postCountAfterR1, "post-restart made ZERO new POSTs");
  restarted.close();

  console.log("v2-chat-legacy-skip smoke: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
