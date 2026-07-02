import assert from "node:assert/strict";
import type { LocalChatRow } from "../src/chatLifecycleStore.js";
import {
  frontmatterAlreadyProjected,
  projectedChatFrontmatter,
  projectedChatStatus,
} from "../src/daemon.js";

function chat(overrides: Partial<LocalChatRow>): LocalChatRow {
  return {
    localKey: "chat:codex:host-1:thread-1",
    projectId: "project-1",
    launchId: "launch-1",
    harness: "codex",
    chatId: "thread-1",
    pending: false,
    status: "waiting",
    title: "Example task",
    cwd: "/tmp/project",
    host: "host-1",
    environment: "codex-app",
    linkedType: "task",
    linkedPath: "tasks/example/task.md",
    resumeKind: "open-chat-command",
    resumePayload: {},
    firstObservedAt: 1_800_000_000_000,
    lastEventAt: 1_800_000_000_000,
    lastStatusAt: 1_800_000_000_000,
    endedAt: null,
    pinned: false,
    pinnedAt: null,
    archivedAt: null,
    deletedAt: null,
    dirty: false,
    lastSyncedAt: null,
    convexId: null,
    updatedAt: 1_800_000_000_000,
    ...overrides,
  };
}

const openTask = `---
title: Example
status: in-progress
chat-harness: codex
chat-id: thread-1
chat-status: waiting
---
Body
`;

// Every projection clears the pre-link summon flag — a bound chat's chat-* fields
// are the truth, so `chat-request*` must never linger beside them.
const clearedRequest = {
  "chat-request": undefined,
  "chat-request-harness": undefined,
  "chat-request-error": undefined,
};

// A codex thread mid-turn inside Hitch's own app-server (codex-app, working) is
// not safe to deep-link yet → chat-open-state: pending. This is now the *sole*
// meaning of chat-open-state (it no longer doubles as "launch in flight").
const working = chat({ status: "working" });
assert.equal(projectedChatStatus(openTask, working), "working");
assert.deepEqual(projectedChatFrontmatter(openTask, working), {
  "chat-harness": "codex",
  "chat-id": "thread-1",
  "chat-status": "working",
  "chat-open-state": "pending",
  "chat-cwd": undefined,
  "chat-env": undefined,
  ...clearedRequest,
});

// cmux codex is always focusable (it's a real terminal pane), so never pending.
const codexCmux = chat({ environment: "cmux", cwd: "/tmp/project" });
assert.deepEqual(projectedChatFrontmatter(openTask, codexCmux), {
  "chat-harness": "codex",
  "chat-id": "thread-1",
  "chat-status": "waiting",
  "chat-open-state": undefined,
  "chat-cwd": "/tmp/project",
  "chat-env": "cmux",
  ...clearedRequest,
});

const alreadyWaiting = chat({ status: "waiting" });
assert.equal(projectedChatStatus(openTask, alreadyWaiting), "waiting");
assert.equal(
  frontmatterAlreadyProjected(
    openTask,
    projectedChatFrontmatter(openTask, alreadyWaiting),
  ),
  true,
);

const terminalTask = openTask.replace("status: in-progress", "status: done");
assert.equal(projectedChatStatus(terminalTask, alreadyWaiting), undefined);
assert.equal(
  projectedChatFrontmatter(terminalTask, alreadyWaiting)["chat-status"],
  undefined,
);

// A non-codex chat is never "open-pending" regardless of status — chat-open-state
// is codex-app-only now. (Unbound rows like this no longer reach the doc anyway:
// projectReducedFileFrontmatter skips chats with no chatId, so `chat-request`
// owns the doc until a real session binds.)
const pendingClaude = chat({
  localKey: "launch:launch-1",
  harness: "claude-code",
  chatId: null,
  pending: true,
  status: "working",
  environment: "cmux",
});
assert.deepEqual(projectedChatFrontmatter(openTask, pendingClaude), {
  "chat-harness": "claude-code",
  "chat-id": undefined,
  "chat-status": "working",
  "chat-open-state": undefined,
  "chat-cwd": "/tmp/project",
  "chat-env": "cmux",
  ...clearedRequest,
});

const ended = chat({ status: "idle", endedAt: 1_800_000_000_100 });
assert.equal(projectedChatStatus(openTask, ended), undefined);
assert.equal(projectedChatFrontmatter(openTask, ended)["chat-pid"], undefined);

console.log("chat frontmatter projection smoke passed");
