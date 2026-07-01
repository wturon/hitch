import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type {
  ChatLifecycleEventInput,
  LocalChatInput,
} from "../src/chatLifecycleStore.js";

// Regression: a Codex chat launched from a task never linked because the
// chat-state observer created a `chat:<id>` row before the hook bind reduced.
// Folding the bind then tried to give that row the pending row's launch_id,
// colliding on unique(local_chats.launch_id) — the reduce transaction rolled
// back and the cursor wedged for EVERY chat. This asserts the two rows coalesce
// (link inherited) and that a genuinely un-reducible event is quarantined
// instead of wedging the cursor.

let ev = 0;
function event(overrides: Partial<ChatLifecycleEventInput>): ChatLifecycleEventInput {
  ev += 1;
  return {
    eventId: `event-${ev}`,
    source: "daemon",
    producer: "daemon-launch",
    harness: "codex",
    providerEvent: "start-chat",
    lifecycle: "chat.created",
    status: "working",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId: null,
    launchId: null,
    turnId: null,
    cwd: "/tmp/project",
    host: "host-1",
    observedAt: 1_800_000_000_000 + ev,
    rawPayloadHash: null,
    rawPayloadRef: null,
    metadata: {},
    ...overrides,
  };
}

function observerRow(overrides: Partial<LocalChatInput>): LocalChatInput {
  return {
    localKey: "override-me",
    projectId: "project-1",
    launchId: null,
    harness: "codex",
    chatId: null,
    pending: false,
    status: "working",
    title: "observed",
    cwd: "/tmp/project",
    host: "host-1",
    environment: "cmux",
    linkedType: null,
    linkedPath: null,
    resumeKind: "external",
    firstObservedAt: 1_800_000_000_000,
    lastEventAt: 1_800_000_000_000,
    lastStatusAt: 1_800_000_000_000,
    endedAt: null,
    updatedAt: 1_800_000_000_000,
    observerCreated: true,
    ...overrides,
  };
}

// --- Test 1: observer-races-hook coalescing --------------------------------
{
  const tempDir = mkdtempSync(join(tmpdir(), "hitch-coalesce-"));
  try {
    const store = openChatLifecycleStore({ appSupportDir: tempDir });
    const X = "launch-X";
    const T = "thread-T";

    // 1) Launch: pending launch:X row carrying the task link.
    store.insertLifecycleEvent(
      event({
        launchId: X,
        metadata: {
          launchId: X,
          linkedType: "task",
          linkedPath: "tasks/foo/task.md",
        },
      }),
    );
    store.reduceLifecycleEvents({ now: 1_800_000_000_100 });
    assert.equal(store.getLocalChat(`launch:${X}`)?.pending, true);

    // 2) Observer independently discovers the running thread (no link).
    store.upsertLocalChat(
      observerRow({ localKey: `chat:codex:host-1:${T}`, chatId: T }),
    );

    // 3) Codex hook binds the thread to the launch (join recovered launchId).
    store.insertLifecycleEvent(
      event({
        source: "hook",
        producer: "codex-hook",
        providerEvent: "UserPromptSubmit",
        lifecycle: "turn.started",
        status: "working",
        chatId: T,
        launchId: X,
        metadata: { environment: "cmux" },
      }),
    );
    const res = store.reduceLifecycleEvents({ now: 1_800_000_000_300 });

    assert.equal(res.failed, 0, "no wedge: nothing quarantined");
    const bound = store.getLocalChat(`chat:codex:host-1:${T}`);
    assert.equal(bound?.chatId, T);
    assert.equal(bound?.launchId, X, "bound row inherited launch id");
    assert.equal(
      bound?.linkedPath,
      "tasks/foo/task.md",
      "bound row inherited the task link (the bug)",
    );
    assert.equal(bound?.pending, false);
    assert.equal(
      store.getLocalChat(`launch:${X}`),
      null,
      "pending launch row coalesced away",
    );
    const linked = store.listFileLinkedChats("project-1");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].chatId, T);

    store.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// --- Test 2: poison event is quarantined, cursor advances ------------------
{
  const tempDir = mkdtempSync(join(tmpdir(), "hitch-quarantine-"));
  try {
    const store = openChatLifecycleStore({ appSupportDir: tempDir });

    // Squat chat_id=T2 under a non-standard key so the reducer's insert for
    // chat:codex:host-1:T2 collides on unique(harness, chat_id, host).
    store.upsertLocalChat(observerRow({ localKey: "squatter", chatId: "T2" }));

    store.insertLifecycleEvent(
      event({
        source: "hook",
        producer: "codex-hook",
        providerEvent: "UserPromptSubmit",
        lifecycle: "turn.started",
        chatId: "T2",
      }),
    );
    const good = store.insertLifecycleEvent(
      event({
        source: "hook",
        producer: "codex-hook",
        providerEvent: "Stop",
        lifecycle: "turn.completed",
        status: "waiting",
        chatId: "T3",
      }),
    );

    const res = store.reduceLifecycleEvents({ now: 1_800_000_000_400 });
    assert.equal(res.failed, 1, "poison event quarantined");
    assert.equal(
      store.getReducerCursor(),
      good.seq,
      "cursor advanced past the poison event",
    );
    assert.ok(
      store.getLocalChat("chat:codex:host-1:T3"),
      "event after the poison one still reduced",
    );

    store.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

console.log("chat-lifecycle-coalesce-smoke: ok");
