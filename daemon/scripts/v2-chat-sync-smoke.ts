import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type { ObservationRecord } from "../src/chatLifecycleStore.js";
import { mapChatStatus, mapHarness } from "../src/v2/chatSync.js";

// --- status mapping (all five mappings + endedAt precedence) ----------------
assert.equal(mapChatStatus({ status: "working", endedAt: null }), "busy");
assert.equal(mapChatStatus({ status: "needs-input", endedAt: null }), "waiting_input");
assert.equal(mapChatStatus({ status: "waiting", endedAt: null }), "waiting_input");
assert.equal(mapChatStatus({ status: "idle", endedAt: null }), "idle");
// endedAt takes precedence over any status.
assert.equal(mapChatStatus({ status: "idle", endedAt: 123 }), "dead");
assert.equal(mapChatStatus({ status: "working", endedAt: 123 }), "dead");
assert.equal(mapChatStatus({ status: "needs-input", endedAt: 123 }), "dead");
assert.equal(mapChatStatus({ status: "waiting", endedAt: 123 }), "dead");

// --- harness mapping --------------------------------------------------------
assert.equal(mapHarness("claude-code"), "claude");
assert.equal(mapHarness("codex"), "codex");

// --- store round-trip of the NEW server_* columns/methods -------------------
const dir = mkdtempSync(join(tmpdir(), "hitch-v2-chat-sync-"));
const HOST = "host-1";

function observation(
  chatId: string,
  overrides: Partial<ObservationRecord> = {},
): ObservationRecord {
  return {
    harness: "claude-code",
    chatId,
    host: HOST,
    cwd: "/tmp/project",
    projectId: "project-1",
    environment: null,
    existence: "running",
    activity: "working",
    source: "claude-pidfile",
    status: "working",
    title: null,
    observedAt: 1_800_000_000_000,
    evidence: null,
    endedAt: null,
    ...overrides,
  };
}

try {
  const store = openChatLifecycleStore({ appSupportDir: dir });
  const key = `chat:claude-code:${HOST}:chat-A`;

  // A freshly observed chat is server-dirty (never synced).
  store.recordObservation(observation("chat-A"));
  let dirty = store.listServerDirtyChats();
  assert.equal(dirty.length, 1, "new chat is server-dirty");
  assert.equal(dirty[0].localKey, key);
  assert.equal(dirty[0].serverSyncedAt, null, "never server-synced yet");
  assert.equal(dirty[0].serverChatId, null, "no server id mapping yet");

  const syncedRow = dirty[0];

  // Mark it synced at its read-time updatedAt, persisting the server id mapping.
  store.markChatServerSynced(key, { serverChatId: "srv-1", syncedAt: syncedRow.updatedAt });
  const afterSync = store.getLocalChat(key);
  assert.equal(afterSync?.serverChatId, "srv-1", "server id persisted on the row");
  assert.equal(afterSync?.serverSyncedAt, syncedRow.updatedAt);

  // Now clean: updated_at hasn't advanced past server_synced_at.
  assert.equal(store.listServerDirtyChats().length, 0, "no longer server-dirty after sync");

  // A status change bumps updated_at → server-dirty again, but the server id is
  // retained (COALESCE) and the mapping still points at srv-1. A later
  // observedAt so updated_at advances past the server_synced_at we just wrote.
  store.recordObservation(
    observation("chat-A", {
      activity: "idle",
      status: "waiting",
      observedAt: 1_800_000_001_000,
    }),
  );
  dirty = store.listServerDirtyChats();
  assert.equal(dirty.length, 1, "status change re-dirties for the server");
  assert.equal(dirty[0].serverChatId, "srv-1", "server id mapping retained across changes");
  assert.equal(mapChatStatus(dirty[0]), "waiting_input", "waiting maps to waiting_input");

  // markChatServerSynced without a serverChatId keeps the existing mapping.
  store.markChatServerSynced(key, { syncedAt: dirty[0].updatedAt });
  assert.equal(store.getLocalChat(key)?.serverChatId, "srv-1", "COALESCE keeps prior id");
  assert.equal(store.listServerDirtyChats().length, 0, "clean after resync");

  // --- V1 dirty flag is independent of the V2 server sync -------------------
  // The Convex `dirty` flag was set when the observation was recorded; V2's
  // markChatServerSynced must NOT have cleared it.
  assert.equal(store.getLocalChat(key)?.dirty, true, "V1 Convex dirty flag untouched by V2 sync");

  // Clearing the V1 flag (markChatSynced) must NOT re-dirty the server sink.
  store.markChatSynced(key, { convexId: "cvx-1" });
  assert.equal(store.getLocalChat(key)?.dirty, false, "V1 flag cleared");
  assert.equal(
    store.listServerDirtyChats().length,
    0,
    "clearing the V1 flag does not touch server_synced_at",
  );
  assert.equal(store.getLocalChat(key)?.serverChatId, "srv-1", "server mapping still intact");

  console.log("v2-chat-sync smoke: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
