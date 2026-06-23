import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import { DaemonLifecycleProducer } from "../src/chatLifecycleProducers.js";

const tempDir = mkdtempSync(join(tmpdir(), "hitch-chat-producers-"));

try {
  const store = openChatLifecycleStore({ appSupportDir: tempDir });
  let now = 1_800_000_000_000;
  const producer = new DaemonLifecycleProducer({
    store,
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    host: "host-1",
    now: () => now++,
  });

  assert.equal(
    producer.chatCreated({
      commandId: "cmd-1",
      launchId: "launch-1",
      automationRunId: "run-1",
      harness: "codex",
      environment: "codex-app",
      cwd: "/tmp/project",
      linkedPath: "tasks/example/task.md",
      title: "Example task",
    }).inserted,
    true,
  );

  assert.equal(
    producer.chatBound({
      commandId: "cmd-1",
      launchId: "launch-1",
      automationRunId: "run-1",
      harness: "codex",
      environment: "codex-app",
      cwd: "/tmp/project",
      linkedPath: "tasks/example/task.md",
      chatId: "thread-1",
    }).inserted,
    true,
  );

  assert.equal(
    producer.chatBound({
      commandId: "cmd-1",
      launchId: "launch-1",
      automationRunId: "run-1",
      harness: "codex",
      environment: "codex-app",
      cwd: "/tmp/project",
      linkedPath: "tasks/example/task.md",
      chatId: "thread-1",
    }).inserted,
    false,
  );

  assert.equal(
    producer.turnCompleted({
      commandId: "cmd-1",
      launchId: "launch-1",
      automationRunId: "run-1",
      harness: "codex",
      environment: "codex-app",
      cwd: "/tmp/project",
      linkedPath: "tasks/example/task.md",
      chatId: "thread-1",
    }).inserted,
    true,
  );

  assert.equal(
    producer.sessionEnded({
      harness: "claude-code",
      environment: "cmux",
      cwd: "/tmp/project",
      linkedPath: "tasks/claude/task.md",
      chatId: "session-1",
      pid: 1234,
    }).inserted,
    true,
  );

  const events = store.readEventsAfter(0);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((event) => [
      event.producer,
      event.lifecycle,
      event.status,
      event.chatId,
      event.launchId,
    ]),
    [
      ["daemon-launch", "chat.created", "working", null, "launch-1"],
      ["daemon-linker", "chat.bound", "working", "thread-1", "launch-1"],
      ["daemon-appserver", "turn.completed", "waiting", "thread-1", "launch-1"],
      ["daemon-reconcile", "session.ended", null, "session-1", null],
    ],
  );
  assert.equal(events[1]?.metadata.linkedPath, "tasks/example/task.md");
  assert.equal(events[2]?.metadata.automationRunId, "run-1");
  assert.equal(events[3]?.metadata.pid, 1234);

  store.close();
  console.log("chat lifecycle producers smoke passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
