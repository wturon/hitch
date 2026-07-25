// TRANSITIONAL smoke — delete with daemon/src/v2/reconcilerBridge.ts.
//
// The reconciler still reads an assignment's progress off the LOCAL chat row.
// The reducer that used to maintain it is gone, so the bridge is now the only
// thing keeping the delegate loop (spawning → running → waiting_input → done)
// alive. This pins the three behaviours that matter, including the two refusals
// that stop it closing a live tab.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openChatLifecycleStore, type LocalChatInput } from "../src/chatLifecycleStore.js";
import type { ChatSnapshot, ObservedChat } from "../src/observer/types.js";
import { ReconcilerBridge, statusFromAxes } from "../src/v2/reconcilerBridge.js";

const HOST = "bridge-host";
const dir = mkdtempSync(join(tmpdir(), "hitch-bridge-"));
const store = openChatLifecycleStore({ appSupportDir: dir });

const chat = (over: Partial<ObservedChat> & Pick<ObservedChat, "harness" | "sessionId">): ObservedChat => ({
  cwd: "/repo",
  process: null,
  existence: "running",
  activity: "idle",
  source: "claude-pidfile",
  evidence: {},
  projectId: null,
  ...over,
});

const snapshot = (chats: ObservedChat[], truncated = false): ChatSnapshot => ({
  observedAt: new Date().toISOString(),
  window: { since: new Date(Date.now() - 86_400_000).toISOString(), cap: 60, truncated },
  chats,
  events: [],
});

function seed(harness: "claude-code" | "codex", sessionId: string): string {
  const localKey = `chat:${harness}:${HOST}:${sessionId}`;
  const now = Date.now();
  const row: LocalChatInput = {
    localKey,
    projectId: null,
    launchId: null,
    harness,
    chatId: sessionId,
    pending: false,
    status: "working",
    title: "delegated",
    cwd: "/repo",
    host: HOST,
    environment: "cmux",
    resumeKind: "open-chat-command",
    resumePayload: {},
    firstObservedAt: now,
    lastEventAt: now,
    lastStatusAt: now,
    endedAt: null,
    updatedAt: now,
  };
  store.upsertLocalChat(row);
  return localKey;
}

try {
  // --- the translation table ------------------------------------------------
  assert.equal(statusFromAxes(chat({ harness: "claude", sessionId: "x", activity: "working" })), "working");
  assert.equal(statusFromAxes(chat({ harness: "claude", sessionId: "x", activity: "idle" })), "waiting");
  assert.equal(
    statusFromAxes(chat({ harness: "claude", sessionId: "x", activity: "unknown" })),
    "waiting",
    "unknown is never reported as working",
  );
  assert.equal(
    statusFromAxes(chat({ harness: "claude", sessionId: "x", activity: "working", block: "permission" })),
    "needs-input",
    "a block wins over activity — that's what the delegate bar renders",
  );
  assert.equal(statusFromAxes(chat({ harness: "claude", sessionId: "x", existence: "dormant" })), "idle");

  // --- it refreshes rows the reconciler owns, and only those ----------------
  const claudeKey = seed("claude-code", "sess-1");
  const bridge = new ReconcilerBridge({ store, host: HOST });

  bridge.apply(snapshot([chat({ harness: "claude", sessionId: "sess-1", activity: "working" })]));
  assert.equal(store.getLocalChat(claudeKey)?.status, "working");

  bridge.apply(snapshot([chat({ harness: "claude", sessionId: "sess-1", activity: "idle" })]));
  assert.equal(store.getLocalChat(claudeKey)?.status, "waiting", "the turn closed → waiting_input");
  assert.equal(store.getLocalChat(claudeKey)?.endedAt, null, "still live");

  // A chat we've never launched must NOT gain a local row.
  bridge.apply(
    snapshot([
      chat({ harness: "claude", sessionId: "sess-1", activity: "idle" }),
      chat({ harness: "claude", sessionId: "discovered-only", activity: "working" }),
    ]),
  );
  assert.equal(
    store.getLocalChat(`chat:claude-code:${HOST}:discovered-only`),
    null,
    "discovery never creates a launch row — the server owns discovered chats",
  );

  // --- running → dormant is the dead-process heal --------------------------
  bridge.apply(snapshot([chat({ harness: "claude", sessionId: "sess-1", existence: "dormant" })]));
  const healed = store.getLocalChat(claudeKey);
  assert.equal(healed?.status, "idle");
  assert.ok(healed?.endedAt, "no live process → ended, with no SessionEnd hook involved");

  // --- vanishing entirely also ends it -------------------------------------
  const goneKey = seed("claude-code", "sess-2");
  const b2 = new ReconcilerBridge({ store, host: HOST });
  b2.apply(snapshot([chat({ harness: "claude", sessionId: "sess-2", activity: "working" })]));
  assert.equal(store.getLocalChat(goneKey)?.endedAt, null);
  b2.apply(snapshot([]));
  assert.ok(store.getLocalChat(goneKey)?.endedAt, "absent from the snapshot → ended");

  // --- but NOT on a truncated snapshot -------------------------------------
  const truncKey = seed("claude-code", "sess-3");
  const b3 = new ReconcilerBridge({ store, host: HOST });
  b3.apply(snapshot([chat({ harness: "claude", sessionId: "sess-3", activity: "working" })]));
  b3.apply(snapshot([], true));
  assert.equal(
    store.getLocalChat(truncKey)?.endedAt,
    null,
    "absence proves nothing when coverage was incomplete",
  );
  // …and the knowledge survives the truncated tick, so a later complete
  // snapshot still concludes it.
  b3.apply(snapshot([]));
  assert.ok(store.getLocalChat(truncKey)?.endedAt, "concluded once coverage is complete again");

  // --- and NEVER for codex --------------------------------------------------
  // Codex's catalog carries no process information, so `dormant` is a heuristic.
  // Concluding "ended" from it would close a live tab.
  const codexKey = seed("codex", "thread-1");
  const b4 = new ReconcilerBridge({ store, host: HOST });
  b4.apply(snapshot([chat({ harness: "codex", sessionId: "thread-1", activity: "working" })]));
  b4.apply(snapshot([chat({ harness: "codex", sessionId: "thread-1", existence: "dormant" })]));
  assert.equal(store.getLocalChat(codexKey)?.status, "idle", "status still tracks the observation");
  assert.equal(store.getLocalChat(codexKey)?.endedAt, null, "but a codex chat is never declared ended here");
  b4.apply(snapshot([]));
  assert.equal(store.getLocalChat(codexKey)?.endedAt, null, "…not even when it disappears");

  console.log("chat-reconciler-bridge smoke: OK");
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
