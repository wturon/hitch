import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";

const tempDir = mkdtempSync(join(tmpdir(), "hitch-chat-lifecycle-"));

try {
  const store = openChatLifecycleStore({ appSupportDir: tempDir });
  const now = Date.now();

  const first = store.insertLifecycleEvent({
    eventId: "event-1",
    source: "hook",
    producer: "codex-hook",
    harness: "codex",
    providerEvent: "UserPromptSubmit",
    lifecycle: "turn.started",
    status: "working",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId: "chat-1",
    launchId: null,
    turnId: "turn-1",
    cwd: "/tmp/project",
    host: "host-1",
    observedAt: now,
    rawPayloadHash: "hash-1",
    rawPayloadRef: null,
    metadata: { toolName: "shell" },
  });
  assert.equal(first.inserted, true);
  assert.equal(first.seq, 1);

  const duplicate = store.insertLifecycleEvent({
    eventId: "event-1",
    source: "hook",
    producer: "codex-hook",
    harness: "codex",
    providerEvent: "UserPromptSubmit",
    lifecycle: "turn.started",
    status: "working",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId: "chat-1",
    launchId: null,
    turnId: "turn-1",
    cwd: "/tmp/project",
    host: "host-1",
    observedAt: now,
    rawPayloadHash: "hash-1",
    rawPayloadRef: null,
    metadata: {},
  });
  assert.deepEqual(duplicate, { inserted: false, seq: null });

  const second = store.insertLifecycleEvent({
    eventId: "event-2",
    source: "daemon",
    producer: "daemon-appserver",
    harness: "codex",
    providerEvent: "turn.completed",
    lifecycle: "turn.completed",
    status: "waiting",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId: "chat-1",
    launchId: null,
    turnId: null,
    cwd: "/tmp/project",
    host: "host-1",
    observedAt: now + 1,
    rawPayloadHash: null,
    rawPayloadRef: null,
    metadata: {},
  });
  assert.equal(second.inserted, true);
  assert.equal(typeof second.seq, "number");
  assert.ok(second.seq > first.seq!);

  const events = store.readEventsAfter(0);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.metadata.toolName, "shell");

  store.setReducerCursor(second.seq!);
  assert.equal(store.getReducerCursor(), second.seq);

  store.markEventsReduced(
    events.map((event) => event.seq),
    now - 8 * 24 * 60 * 60 * 1000,
  );
  assert.equal(store.readUnreducedEvents().length, 0);

  store.upsertLocalChat({
    localKey: "chat:codex:host-1:chat-1",
    projectId: "project-1",
    launchId: null,
    harness: "codex",
    chatId: "chat-1",
    pending: false,
    status: "waiting",
    title: "Example chat",
    cwd: "/tmp/project",
    host: "host-1",
    environment: "codex-app",
    linkedType: "task",
    linkedPath: "tasks/example/task.md",
    resumeKind: "open-chat-command",
    resumePayload: { commandId: "command-1" },
    firstObservedAt: now,
    lastEventAt: now + 1,
    lastStatusAt: now + 1,
    endedAt: null,
    dirty: true,
    updatedAt: now + 1,
  });

  assert.equal(store.listDirtyChats().length, 1);
  store.markChatSynced("chat:codex:host-1:chat-1", {
    convexId: "convex-chat-1",
    syncedAt: now + 2,
  });
  assert.equal(store.listDirtyChats().length, 0);
  assert.equal(
    store.getLocalChat("chat:codex:host-1:chat-1")?.convexId,
    "convex-chat-1",
  );

  store.markChatDirty("chat:codex:host-1:chat-1", now + 3);
  assert.equal(store.listDirtyChats().length, 1);

  const deleted = store.cleanupReducedEvents({ now });
  assert.equal(deleted, 2);
  assert.equal(store.readEventsAfter(0).length, 0);

  store.close();
  console.log("chat lifecycle store smoke passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
