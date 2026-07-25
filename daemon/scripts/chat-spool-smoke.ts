// The hook inbox, end to end: spool dir + cursors.json.
//
// Replaces the old chat-lifecycle-store / -reducer / -coalesce / -wakeup /
// hook-fixtures smokes, which all tested a SQLite event ledger that no longer
// exists (docs/chat-tracking-redesign.md §6). What matters now is much smaller:
// a file lands, a file drains, a bad file dies quietly, and cursors survive a
// restart without ever being load-bearing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { CursorStore } from "../src/observer/cursors.js";
import { EventSpool, parseSpooledEvent, resolveSpoolPaths } from "../src/observer/spool.js";
import { hookEvent, spoolHookEvent } from "./support/observerFixture.js";

const dir = mkdtempSync(join(tmpdir(), "hitch-spool-"));
try {
  // --- paths ---------------------------------------------------------------
  const paths = resolveSpoolPaths({ HITCH_APP_SUPPORT_DIR: dir } as NodeJS.ProcessEnv);
  assert.equal(paths.eventsDir, join(resolve(dir), "events"));
  assert.equal(paths.cursorsPath, join(resolve(dir), "cursors.json"));

  // --- drain ---------------------------------------------------------------
  const spool = new EventSpool({ dir: paths.eventsDir });
  spool.start();

  spoolHookEvent(paths.eventsDir, hookEvent("claude-code", "sess-a", "turn.started", { observedAt: 1000 }));
  spoolHookEvent(paths.eventsDir, hookEvent("codex", "thread-b", "turn.needs_input", { observedAt: 3000 }));
  spoolHookEvent(paths.eventsDir, hookEvent("claude-code", "sess-a", "turn.completed", { observedAt: 2000 }));
  // A file that is not JSON at all, and one that is JSON but not an event.
  writeFileSync(join(paths.eventsDir, "9999-badbad.json"), "{not json", "utf8");
  writeFileSync(join(paths.eventsDir, "9998-nochat.json"), JSON.stringify({ harness: "codex" }), "utf8");
  // A half-written file the hook hasn't renamed yet — must be invisible.
  writeFileSync(join(paths.eventsDir, "9997-inflight.tmp"), "{partial", "utf8");

  const first = spool.drain();
  assert.equal(first.events.length, 3, "three usable events");
  assert.equal(first.malformed, 2, "both bad files counted as malformed");
  assert.deepEqual(
    first.events.map((e) => e.observedAt),
    [1000, 2000, 3000],
    "events come out in producer-timestamp order",
  );
  assert.equal(first.events[1].lifecycle, "turn.completed");
  assert.equal(first.events[2].harness, "codex", "harness survives the round trip (server disambiguator)");

  const left = readdirSync(paths.eventsDir);
  assert.deepEqual(left, ["9997-inflight.tmp"], "every .json is gone; the .tmp is untouched");

  const second = spool.drain();
  assert.equal(second.events.length, 0, "an inbox is not a log — a drained event is gone");
  assert.equal(second.malformed, 0, "a malformed file is deleted, never retried forever");
  spool.stop();

  // --- the drain limit leaves a backlog rather than dropping work ----------
  for (let i = 0; i < 5; i++) {
    spoolHookEvent(paths.eventsDir, hookEvent("claude-code", "sess-c", "turn.started", { observedAt: 100 + i }));
  }
  const capped = new EventSpool({ dir: paths.eventsDir }).drain(2);
  assert.equal(capped.events.length, 2);
  assert.equal(capped.remaining, 3, "the rest stay on disk for the next tick");
  assert.equal(new EventSpool({ dir: paths.eventsDir }).drain().events.length, 3);

  // --- parse guards --------------------------------------------------------
  assert.equal(parseSpooledEvent("[]"), null, "an array is not an event");
  assert.equal(parseSpooledEvent(JSON.stringify({ chatId: "x", harness: "codex" })), null, "no lifecycle");
  assert.equal(parseSpooledEvent(JSON.stringify({ lifecycle: "x", harness: "codex" })), null, "no chatId");

  // --- hook fixtures still normalize into spoolable events ------------------
  // The recorded payloads live in docs/fixtures/chat-lifecycle-hooks. We assert
  // the shape the hook produces for each one survives the spool unchanged —
  // chat identity, harness and lifecycle are the three fields the daemon and
  // the server both key on.
  const fixtureDir = resolve(import.meta.dirname, "../../docs/fixtures/chat-lifecycle-hooks");
  const LIFECYCLE_BY_EVENT: Record<string, string> = {
    UserPromptSubmit: "turn.started",
    PreToolUse: "turn.resumed",
    PermissionRequest: "turn.needs_input",
    Notification: "turn.needs_input",
    Stop: "turn.completed",
    SessionStart: "session.started",
    SessionEnd: "session.ended",
  };
  const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));
  assert.ok(fixtures.length > 0, "fixtures exist");
  for (const file of fixtures) {
    const payload = JSON.parse(readFileSync(join(fixtureDir, file), "utf8")) as Record<string, unknown>;
    const providerEvent = String(payload.hook_event_name ?? payload.hookEventName);
    const lifecycle = LIFECYCLE_BY_EVENT[providerEvent];
    assert.ok(lifecycle, `${file}: known hook event`);
    const chatId = String(payload.session_id ?? payload.sessionId ?? payload.thread_id ?? payload.threadId);
    assert.ok(chatId && chatId !== "undefined", `${file}: carries a chat id`);
    const harness = basename(file).startsWith("codex-") ? "codex" : "claude-code";
    spoolHookEvent(paths.eventsDir, hookEvent(harness, chatId, lifecycle, { providerEvent }));
  }
  const drained = new EventSpool({ dir: paths.eventsDir }).drain();
  assert.equal(drained.events.length, fixtures.length, "every fixture round-tripped");
  assert.ok(
    drained.events.every((e) => e.harness === "codex" || e.harness === "claude-code"),
    "every relayed event names its harness",
  );

  // --- cursors: persistent, and disposable ---------------------------------
  const cursorsPath = paths.cursorsPath;
  const cursors = new CursorStore(cursorsPath);
  assert.equal(cursors.get("claude:sess-a"), null);
  cursors.set("claude:sess-a", { dev: 1, ino: 2, offset: 30, size: 30, mtimeMs: 111, seenAt: Date.now() });
  cursors.flush();
  const reopened = new CursorStore(cursorsPath);
  assert.equal(reopened.get("claude:sess-a")?.offset, 30, "a cursor survives a restart");

  reopened.set("claude:old", { dev: 1, ino: 3, offset: 0, size: 0, mtimeMs: 0, seenAt: 0 });
  reopened.prune(1000, 10_000);
  assert.equal(reopened.get("claude:old"), null, "stale cursors are pruned");
  assert.ok(reopened.get("claude:sess-a"), "fresh cursors are kept");

  // Corrupt it: the daemon must start clean, not die.
  writeFileSync(cursorsPath, "{ this is not json", "utf8");
  const recovered = new CursorStore(cursorsPath);
  assert.equal(recovered.size, 0, "a corrupt cursor file costs precision, not a daemon");

  // Delete it: same deal.
  rmSync(cursorsPath, { force: true });
  assert.equal(new CursorStore(cursorsPath).size, 0);

  // An unwritable path is swallowed too.
  const doomed = new CursorStore(join(dir, "no", "such", "dir", "cursors.json"));
  doomed.set("x", { dev: 0, ino: 0, offset: 0, size: 0, mtimeMs: 0, seenAt: 0 });
  doomed.flush();

  // --- a missing spool dir is not an error ---------------------------------
  rmSync(paths.eventsDir, { recursive: true, force: true });
  const gone = new EventSpool({ dir: paths.eventsDir });
  assert.deepEqual(gone.drain(), { events: [], malformed: 0, remaining: 0 });
  gone.start();
  assert.ok(readdirSync(dir).includes("events"), "start() recreates the spool dir");
  gone.stop();

  console.log("chat-spool smoke: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
}
