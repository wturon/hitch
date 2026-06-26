import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type { ChatLifecycleEventInput } from "../src/chatLifecycleStore.js";

const tempDir = mkdtempSync(join(tmpdir(), "hitch-chat-reducer-"));

function event(
  id: string,
  overrides: Partial<ChatLifecycleEventInput>,
): ChatLifecycleEventInput {
  return {
    eventId: id,
    source: "daemon",
    producer: "daemon-launch",
    harness: "codex",
    providerEvent: "test",
    lifecycle: "chat.created",
    status: "working",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId: null,
    launchId: "launch-1",
    turnId: null,
    cwd: "/tmp/project",
    host: "host-1",
    observedAt: 1_800_000_000_000,
    rawPayloadHash: null,
    rawPayloadRef: null,
    metadata: {
      environment: "codex-app",
      linkedType: "task",
      linkedPath: "tasks/example/task.md",
      automationRunId: "run-1",
      title: "Example task",
    },
    ...overrides,
  };
}

try {
  const store = openChatLifecycleStore({ appSupportDir: tempDir });

  const created = store.insertLifecycleEvent(event("created", {}));
  assert.equal(created.inserted, true);
  let result = store.reduceLifecycleEvents({ now: 1_800_000_000_100 });
  assert.deepEqual(result, {
    eventsReduced: 1,
    chatsChanged: 1,
    cursor: created.seq,
  });

  let pending = store.getLocalChat("launch:launch-1");
  assert.equal(pending?.pending, true);
  assert.equal(pending?.status, "working");
  assert.equal(pending?.title, "Example task");
  assert.equal(store.readUnreducedEvents().length, 0);
  store.markChatSynced("launch:launch-1", { syncedAt: 1_800_000_000_101 });

  const bound = store.insertLifecycleEvent(
    event("bound", {
      producer: "daemon-linker",
      lifecycle: "chat.bound",
      chatId: "thread-1",
      observedAt: 1_800_000_000_200,
    }),
  );
  result = store.reduceLifecycleEvents({ now: 1_800_000_000_300 });
  assert.deepEqual(result, {
    eventsReduced: 1,
    chatsChanged: 1,
    cursor: bound.seq,
  });

  assert.equal(store.getLocalChat("launch:launch-1"), null);
  const boundChat = store.getLocalChat("chat:codex:host-1:thread-1");
  assert.equal(boundChat?.launchId, "launch-1");
  assert.equal(boundChat?.pending, false);
  assert.equal(boundChat?.resumePayload.automationRunId, "run-1");
  assert.equal(boundChat?.dirty, true);
  store.markChatSynced("chat:codex:host-1:thread-1", {
    syncedAt: 1_800_000_000_301,
  });

  const completed = store.insertLifecycleEvent(
    event("completed", {
      producer: "daemon-appserver",
      lifecycle: "turn.completed",
      status: "waiting",
      chatId: "thread-1",
      observedAt: 1_800_000_000_400,
    }),
  );
  result = store.reduceLifecycleEvents({ now: 1_800_000_000_500 });
  assert.equal(result.eventsReduced, 1);
  assert.equal(result.chatsChanged, 1);
  assert.equal(result.cursor, completed.seq);
  assert.equal(
    store.getLocalChat("chat:codex:host-1:thread-1")?.status,
    "waiting",
  );
  store.markChatSynced("chat:codex:host-1:thread-1", {
    syncedAt: 1_800_000_000_501,
  });

  const noChange = store.insertLifecycleEvent(
    event("completed-same-time", {
      producer: "daemon-appserver",
      lifecycle: "turn.completed",
      status: "waiting",
      chatId: "thread-1",
      observedAt: 1_800_000_000_400,
    }),
  );
  result = store.reduceLifecycleEvents({ now: 1_800_000_000_600 });
  assert.deepEqual(result, {
    eventsReduced: 1,
    chatsChanged: 0,
    cursor: noChange.seq,
  });
  assert.equal(store.listDirtyChats().length, 0);

  const ended = store.insertLifecycleEvent(
    event("ended", {
      producer: "daemon-reconcile",
      lifecycle: "session.ended",
      status: null,
      chatId: "thread-1",
      observedAt: 1_800_000_000_700,
    }),
  );
  result = store.reduceLifecycleEvents({ now: 1_800_000_000_800 });
  assert.equal(result.eventsReduced, 1);
  assert.equal(result.chatsChanged, 1);
  assert.equal(result.cursor, ended.seq);
  const endedChat = store.getLocalChat("chat:codex:host-1:thread-1");
  assert.equal(endedChat?.status, "idle");
  assert.equal(endedChat?.endedAt, 1_800_000_000_700);

  const cmuxCreated = store.insertLifecycleEvent(
    event("cmux-created", {
      launchId: "launch-2",
      metadata: {
        environment: "cmux",
        linkedType: "task",
        linkedPath: "tasks/codex-cmux/task.md",
        title: "Codex cmux task",
      },
      observedAt: 1_800_000_000_900,
    }),
  );
  result = store.reduceLifecycleEvents({ now: 1_800_000_001_000 });
  assert.equal(result.eventsReduced, 1);
  assert.equal(result.chatsChanged, 1);
  assert.equal(result.cursor, cmuxCreated.seq);
  assert.equal(store.getLocalChat("launch:launch-2")?.pending, true);

  const cmuxHookBound = store.insertLifecycleEvent(
    event("cmux-hook-bound", {
      source: "hook",
      producer: "codex-hook",
      providerEvent: "UserPromptSubmit",
      lifecycle: "turn.started",
      launchId: "launch-2",
      chatId: "thread-2",
      metadata: { environment: "cmux" },
      observedAt: 1_800_000_001_100,
    }),
  );
  result = store.reduceLifecycleEvents({ now: 1_800_000_001_200 });
  assert.equal(result.eventsReduced, 1);
  assert.equal(result.chatsChanged, 1);
  assert.equal(result.cursor, cmuxHookBound.seq);
  assert.equal(store.getLocalChat("launch:launch-2"), null);
  const cmuxBound = store.getLocalChat("chat:codex:host-1:thread-2");
  assert.equal(cmuxBound?.launchId, "launch-2");
  assert.equal(cmuxBound?.pending, false);
  assert.equal(cmuxBound?.environment, "cmux");
  assert.equal(cmuxBound?.linkedPath, "tasks/codex-cmux/task.md");

  store.close();
  console.log("chat lifecycle reducer smoke passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
