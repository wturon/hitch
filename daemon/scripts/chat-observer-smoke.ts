// The observer, over a fabricated machine.
//
// docs/chat-tracking-redesign.md §5–§7. Asserts the things the snapshot model
// stands on:
//   - existence comes from the machine (a live process → running; a transcript
//     inside the window with no process → dormant)
//   - activity comes from the harness's own self-report where it has one
//   - block comes ONLY from spooled hook events, and dies with its chat
//   - a chat that vanishes is carried for exactly ONE tick, then dropped —
//     because the server acts on first absence
//   - the working set is capped, and says so via window.truncated

import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { ChatObserver } from "../src/observer/index.js";
import { resolveSpoolPaths } from "../src/observer/spool.js";
import type { ChatSnapshot } from "../src/observer/types.js";
import { createFakeMachine, hookEvent, spoolHookEvent } from "./support/observerFixture.js";

const machine = createFakeMachine();
const paths = resolveSpoolPaths(process.env);
const logger = { info: () => {}, error: (m: string) => console.error(m) };

const published: ChatSnapshot[] = [];
const observer = new ChatObserver({
  paths,
  projects: [{ projectId: "11111111-1111-4111-8111-111111111111", localPath: machine.projectDir }],
  host: "smoke-host",
  logger,
  publish: (snapshot) => {
    published.push(snapshot);
  },
});

const latest = () => published[published.length - 1];
const find = (harness: string, sessionId: string) =>
  latest().chats.find((c) => c.harness === harness && c.sessionId === sessionId);

try {
  // A permission prompt fired before the first tick — the hook wrote it while
  // the daemon was, as far as it knows, not looking.
  spoolHookEvent(
    paths.eventsDir,
    hookEvent("claude-code", machine.liveSessionId, "turn.needs_input"),
  );

  await observer.runOnce("smoke-1");
  assert.equal(published.length, 1, "one tick, one snapshot");
  const first = latest();
  assert.equal(first.window.truncated, false, "coverage complete");
  assert.ok(Date.parse(first.observedAt) > 0, "observedAt is an ISO instant");
  assert.ok(Date.parse(first.window.since) < Date.parse(first.observedAt));

  // --- existence -----------------------------------------------------------
  const live = find("claude", machine.liveSessionId);
  assert.ok(live, "the live Claude session is in the snapshot");
  assert.equal(live.existence, "running", "a live process means running");
  assert.equal(live.activity, "working", "the pidfile self-reported busy");
  assert.equal(live.source, "claude-pidfile", "pidfile is the primary sensor");
  assert.ok(live.process && live.process.pid > 0, "process identity carries a pid");
  assert.ok(live.process?.startedAt, "…and a start time");
  assert.equal(live.cwd, machine.projectDir);
  assert.equal(live.projectId, "11111111-1111-4111-8111-111111111111", "cwd → project");
  assert.equal(live.title, "Live smoke chat");

  const dormant = find("claude", machine.dormantSessionId);
  assert.ok(dormant, "a transcript inside the window with no process is still a chat");
  assert.equal(dormant.existence, "dormant");
  assert.equal(dormant.activity, "idle", "dormant is idle by definition");
  assert.equal(dormant.process, null, "no process, and we say so");
  assert.equal(dormant.cwd, machine.projectDir, "cwd recovered from the transcript");

  const codex = find("codex", machine.codexThreadId);
  assert.ok(codex, "the Codex thread catalog is discovery, not archaeology");
  assert.equal(codex.existence, "dormant", "no codex process → dormant, never a guess");
  assert.equal(codex.activity, "idle");
  assert.equal(codex.title, "Codex smoke thread");

  // --- block ---------------------------------------------------------------
  assert.equal(live.block, "permission", "the hook event is the only source of block");
  assert.equal(dormant.block, undefined, "no belief about an unrelated chat's block");
  assert.equal(first.events.length, 1, "the event is relayed as history too");
  assert.equal(first.events[0].harness, "claude", "…keyed by the full natural key");
  assert.equal(first.events[0].sessionId, machine.liveSessionId);
  assert.equal(first.events[0].kind, "turn.needs_input");

  // The spool is drained, not read: a second tick carries no events.
  await observer.runOnce("smoke-2");
  assert.equal(latest().events.length, 0, "drained means gone");
  assert.equal(find("claude", machine.liveSessionId)?.block, "permission", "the belief persists");

  // Anything else from that chat clears the block.
  spoolHookEvent(paths.eventsDir, hookEvent("claude-code", machine.liveSessionId, "turn.completed"));
  await observer.runOnce("smoke-3");
  assert.equal(find("claude", machine.liveSessionId)?.block, null, "a later event clears the block");

  // --- a process dying is a TRANSITION, not a disappearance ----------------
  // The chat stays in the snapshot with existence `dormant`, because its
  // transcript is still inside the recency window. Aging out is not deletion:
  // it's resumable, still visible, and idle rather than dead.
  machine.killLiveSession();
  await observer.runOnce("smoke-4");
  const settled = find("claude", machine.liveSessionId);
  assert.ok(settled, "the chat is still there");
  assert.equal(settled.existence, "dormant", "running → dormant, with no hook involved at all");
  assert.equal(settled.activity, "idle");
  assert.equal(settled.process, null);

  // --- the 2-miss debounce -------------------------------------------------
  // A chat that vanishes from its harness's own catalog entirely. The server
  // acts on FIRST absence, so the daemon has to absorb a one-tick blip.
  machine.removeCodexThread();
  await observer.runOnce("smoke-5");
  const carried = find("codex", machine.codexThreadId);
  assert.ok(carried, "one miss does NOT remove a chat — that's what the debounce buys");
  assert.equal(carried.source, "carry-over");
  assert.equal(carried.evidence.missed, 1);

  await observer.runOnce("smoke-6");
  assert.equal(
    find("codex", machine.codexThreadId),
    undefined,
    "two consecutive misses: it leaves the snapshot, and the server calls it dead",
  );

  // --- the cap -------------------------------------------------------------
  const capped: ChatSnapshot[] = [];
  const small = new ChatObserver({
    paths,
    projects: [],
    host: "smoke-host",
    logger,
    cap: 1,
    publish: (s) => {
      capped.push(s);
    },
  });
  await small.runOnce("cap");
  assert.equal(capped[0].chats.length, 1, "the working set is bounded");
  assert.equal(capped[0].window.cap, 1);
  assert.equal(
    capped[0].window.truncated,
    true,
    "TRUNCATED is load-bearing: the server skips its death sweep entirely",
  );
  await small.stop();

  // --- a narrow window ages chats out --------------------------------------
  const narrow: ChatSnapshot[] = [];
  const shortWindow = new ChatObserver({
    paths,
    projects: [],
    host: "smoke-host",
    logger,
    windowMs: 1,
    publish: (s) => {
      narrow.push(s);
    },
  });
  await shortWindow.runOnce("window");
  assert.equal(
    narrow[0].chats.filter((c) => c.existence === "dormant").length,
    0,
    "nothing older than the window is considered",
  );
  await shortWindow.stop();

  console.log("chat-observer smoke: OK");
} finally {
  await observer.stop();
  rmSync(paths.cursorsPath, { force: true });
  machine.cleanup();
}
