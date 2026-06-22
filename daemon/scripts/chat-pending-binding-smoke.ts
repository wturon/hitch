import assert from "node:assert/strict";
import { pendingChatBindingArgs } from "../src/daemon.js";

const bound = pendingChatBindingArgs({
  cmd: { launchId: "launch-1" },
  projectId: "project-1",
  deviceToken: "device-token-1",
  harness: "codex",
  chatId: "thread-1",
  host: "host-1",
  cwd: "/tmp/project",
  status: "working",
  environment: "codex-app",
  observedAt: 1_800_000_000_000,
});

assert.deepEqual(bound, {
  projectId: "project-1",
  deviceToken: "device-token-1",
  launchId: "launch-1",
  harness: "codex",
  chatId: "thread-1",
  host: "host-1",
  cwd: "/tmp/project",
  status: "working",
  environment: "codex-app",
  resumeKind: "open-chat-command",
  resumePayload: {},
  observedAt: 1_800_000_000_000,
});

const legacy = pendingChatBindingArgs({
  cmd: {},
  projectId: "project-1",
  deviceToken: "device-token-1",
  harness: "claude-code",
  chatId: "session-1",
  host: "host-1",
  cwd: "/tmp/project",
  status: "working",
  environment: "cmux",
});

assert.equal(legacy, null);

console.log("chat pending binding smoke passed");
