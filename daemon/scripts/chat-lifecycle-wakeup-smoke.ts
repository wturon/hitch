import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import chokidar from "chokidar";
import { openChatLifecycleStore } from "../src/chatLifecycleStore.js";
import type { ChatLifecycleEventInput } from "../src/chatLifecycleStore.js";

const tempDir = mkdtempSync(join(tmpdir(), "hitch-chat-wakeup-"));

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await wait(25);
  }
  assert.equal(predicate(), true);
}

function event(id: string, launchId: string): ChatLifecycleEventInput {
  return {
    eventId: id,
    source: "daemon",
    producer: "daemon-launch",
    harness: "claude-code",
    providerEvent: "test",
    lifecycle: "chat.created",
    status: "working",
    projectId: "project-1",
    projectLocalPath: "/tmp/project",
    chatId: null,
    launchId,
    turnId: null,
    cwd: "/tmp/project",
    host: "host-1",
    observedAt: Date.now(),
    rawPayloadHash: null,
    rawPayloadRef: null,
    metadata: { environment: "cmux", title: "Wakeup test" },
  };
}

try {
  const store = openChatLifecycleStore({ appSupportDir: tempDir });
  let watcherReductions = 0;
  let debounce: NodeJS.Timeout | undefined;
  const bumpName = basename(store.paths.bumpPath);
  const isBump = (path: string) => basename(path) === bumpName;
  const watcher = chokidar.watch(dirname(store.paths.bumpPath), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 20, pollInterval: 10 },
  });
  const watcherReady = new Promise<void>((resolve) =>
    watcher.on("ready", () => resolve()),
  );
  watcher.on("add", (path) => {
    if (!isBump(path)) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      watcherReductions += store.reduceLifecycleEvents().eventsReduced;
    }, 25);
  });
  watcher.on("change", (path) => {
    if (!isBump(path)) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      watcherReductions += store.reduceLifecycleEvents().eventsReduced;
    }, 25);
  });

  await watcherReady;
  store.insertLifecycleEvent(event("watcher", "launch-watcher"));
  await waitFor(() => watcherReductions === 1);
  assert.equal(store.getLocalChat("launch:launch-watcher")?.title, "Wakeup test");

  if (debounce) clearTimeout(debounce);
  await watcher.close();

  let pollingReductions = 0;
  const poll = setInterval(() => {
    pollingReductions += store.reduceLifecycleEvents().eventsReduced;
  }, 25);
  store.insertLifecycleEvent(event("poll", "launch-poll"));
  await waitFor(() => pollingReductions === 1);
  clearInterval(poll);
  assert.equal(store.getLocalChat("launch:launch-poll")?.status, "working");

  store.close();
  console.log("chat lifecycle wakeup smoke passed");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
