import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type {
  ChatLifecycleEventInput,
  ObservationRecord,
} from "../src/chatLifecycleStore.js";

const dir = mkdtempSync(join(tmpdir(), "hitch-observer-store-"));
const HOST = "host-1";

function hookEvent(
  chatId: string,
  overrides: Partial<ChatLifecycleEventInput> = {},
): ChatLifecycleEventInput {
  return {
    eventId: `evt:${chatId}:${overrides.lifecycle ?? "turn.started"}`,
    source: "hook",
    producer: "claude-code-hook",
    harness: "claude-code",
    providerEvent: "UserPromptSubmit",
    lifecycle: "turn.started",
    status: "working",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId,
    launchId: null,
    turnId: null,
    cwd: "/tmp/project",
    host: HOST,
    observedAt: 1_800_000_000_000,
    rawPayloadHash: null,
    rawPayloadRef: null,
    metadata: {},
    ...overrides,
  };
}

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
    observedAt: 1_800_000_000_500,
    evidence: { pidfileStatus: "busy" },
    endedAt: null,
    ...overrides,
  };
}

try {
  const store = openChatLifecycleStore({ appSupportDir: dir });

  // --- event-backed row: observer writes shadow only, never status ----------
  store.insertLifecycleEvent(hookEvent("chat-A"));
  store.reduceLifecycleEvents({ now: 1_800_000_000_100 });
  const keyA = `chat:claude-code:${HOST}:chat-A`;
  let a = store.getLocalChat(keyA);
  assert.equal(a?.status, "working");
  assert.equal(a?.observerCreated, false);

  // Observer says the live status is "waiting" (running + idle). Status must
  // stay hook-driven; only the shadow columns move, and the row goes dirty.
  const changed = store.recordObservation(
    observation("chat-A", { activity: "idle", status: "waiting" }),
  );
  assert.equal(changed, true);
  a = store.getLocalChat(keyA);
  assert.equal(a?.status, "working", "dark: hook status preserved");
  assert.equal(a?.observedStatus, "waiting", "shadow recorded");
  assert.equal(a?.observedActivity, "idle");
  assert.equal(a?.observedSource, "claude-pidfile");
  assert.equal(a?.dirty, true, "shadow change marks the row for sync");

  // Idempotent: same observation again = no change, no extra dirtying churn.
  store.markChatSynced(keyA);
  const again = store.recordObservation(
    observation("chat-A", { activity: "idle", status: "waiting" }),
  );
  assert.equal(again, false, "unchanged observation is a no-op");
  assert.equal(store.getLocalChat(keyA)?.dirty, false);

  // --- observer-only row: observer owns status ------------------------------
  const keyB = `chat:claude-code:${HOST}:chat-B`;
  store.recordObservation(observation("chat-B", { status: "working" }));
  let b = store.getLocalChat(keyB);
  assert.equal(b?.status, "working");
  assert.equal(b?.observerCreated, true, "observer produced this row");
  assert.equal(b?.resumeKind, "external");

  store.recordObservation(
    observation("chat-B", { activity: "idle", status: "waiting" }),
  );
  b = store.getLocalChat(keyB);
  assert.equal(b?.status, "waiting", "observer-only row: observer drives status");

  // A hook event later binds the observer-only row → ownership reverts to events.
  store.insertLifecycleEvent(
    hookEvent("chat-B", { eventId: "evt:chat-B:bind", lifecycle: "turn.started" }),
  );
  store.reduceLifecycleEvents({ now: 1_800_000_001_000 });
  b = store.getLocalChat(keyB);
  assert.equal(b?.observerCreated, false, "event binding clears observer ownership");
  assert.equal(b?.status, "working", "events now drive status");

  store.recordObservation(
    observation("chat-B", { activity: "idle", status: "waiting" }),
  );
  b = store.getLocalChat(keyB);
  assert.equal(b?.status, "working", "post-binding: observer is shadow-only again");
  assert.equal(b?.observedStatus, "waiting");

  // --- createIfMissing gate: dormant chats don't flood the registry ---------
  const dormant = store.recordObservation(
    observation("chat-C", { existence: "dormant", activity: "idle", status: "idle" }),
    { createIfMissing: false },
  );
  assert.equal(dormant, false);
  assert.equal(store.getLocalChat(`chat:claude-code:${HOST}:chat-C`), null);

  // --- observed_files cursor round-trip -------------------------------------
  assert.equal(store.getObservedFile("claude-code", "chat-A", HOST), null);
  store.setObservedFile({
    harness: "claude-code",
    chatId: "chat-A",
    host: HOST,
    logPath: "/x/y.jsonl",
    offset: 4096,
    fileDev: 11,
    fileIno: 22,
    fileSize: 5000,
    fileMtimeMs: 1_800_000_000_999,
    updatedAt: 1_800_000_001_000,
  });
  const cursor = store.getObservedFile("claude-code", "chat-A", HOST);
  assert.equal(cursor?.offset, 4096);
  assert.equal(cursor?.fileIno, 22);
  store.setObservedFile({
    harness: "claude-code",
    chatId: "chat-A",
    host: HOST,
    logPath: "/x/y.jsonl",
    offset: 8192,
    fileDev: 11,
    fileIno: 22,
    fileSize: 9000,
    fileMtimeMs: 1_800_000_002_000,
    updatedAt: 1_800_000_002_000,
  });
  assert.equal(
    store.getObservedFile("claude-code", "chat-A", HOST)?.offset,
    8192,
    "cursor upserts in place",
  );

  console.log("observer-store-smoke: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
