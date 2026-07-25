// THE DISPOSABILITY TEST (docs/chat-tracking-redesign.md §6).
//
// "Delete either file at any moment and you lose in-flight events at worst.
//  Add it to CI — wipe the files, run one tick, assert the world re-derives.
//  (Today you'd lose 748 chats.)"
//
// This is the assertion that the daemon holds NO chat state. The spool is an
// inbox, cursors.json is an optimization, and everything the product renders is
// re-derived from the machine every tick. If this ever starts failing, some
// piece of truth has quietly moved back into the daemon.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";

import { ChatObserver } from "../src/observer/index.js";
import { resolveSpoolPaths } from "../src/observer/spool.js";
import { ChatSnapshotSink } from "../src/v2/chatSnapshot.js";
import type { ChatSnapshot } from "../src/observer/types.js";
import { createFakeMachine, hookEvent, spoolHookEvent } from "./support/observerFixture.js";

const machine = createFakeMachine();
const paths = resolveSpoolPaths(process.env);
const logger = { info: () => {}, error: (m: string) => console.error(m) };

// The identity of a snapshot's world: who is here, and what state are they in.
// Deliberately excludes evidence/source (mtime ages move every second) — this
// is "did the world re-derive", not "is the JSON byte-identical".
const world = (snapshot: ChatSnapshot) =>
  snapshot.chats
    .map((c) => `${c.harness}/${c.sessionId}:${c.existence}/${c.activity}:${c.cwd ?? "-"}`)
    .sort();

function makeObserver(sink: ChatSnapshot[]) {
  return new ChatObserver({
    paths,
    projects: [{ projectId: "22222222-2222-4222-8222-222222222222", localPath: machine.projectDir }],
    host: "smoke-host",
    logger,
    publish: (s) => {
      sink.push(s);
    },
  });
}

try {
  // --- a warm daemon, mid-conversation -------------------------------------
  const warmSnapshots: ChatSnapshot[] = [];
  const warm = makeObserver(warmSnapshots);
  // A vscode-style session: it self-reports nothing, so the observer falls back
  // to the transcript tail and therefore KEEPS A CURSOR. That's the state we
  // want to prove is disposable.
  machine.setLiveStatus(null);
  spoolHookEvent(paths.eventsDir, hookEvent("claude-code", machine.liveSessionId, "turn.needs_input"));
  await warm.runOnce("warm-1");
  await warm.runOnce("warm-2");
  await warm.stop();

  const before = world(warmSnapshots[warmSnapshots.length - 1]);
  assert.ok(before.length >= 3, `expected a populated world, got ${before.length} chats`);
  assert.ok(existsSync(paths.cursorsPath), "the warm daemon wrote cursors");

  // --- now wipe every byte of local state ----------------------------------
  rmSync(paths.eventsDir, { recursive: true, force: true });
  rmSync(paths.cursorsPath, { force: true });
  // …and the sqlite store too, for good measure: no part of it backs the
  // snapshot any more.
  rmSync(`${paths.appSupportDir}/chat-lifecycle.sqlite`, { force: true });
  assert.ok(!existsSync(paths.eventsDir), "spool gone");
  assert.ok(!existsSync(paths.cursorsPath), "cursors gone");

  // --- one tick, from nothing ----------------------------------------------
  const coldSnapshots: ChatSnapshot[] = [];
  const cold = makeObserver(coldSnapshots);
  await cold.runOnce("cold");
  assert.equal(coldSnapshots.length, 1, "one tick, one snapshot");
  const after = world(coldSnapshots[0]);

  assert.deepEqual(after, before, "the whole world re-derives from the machine alone");
  assert.equal(coldSnapshots[0].window.truncated, false, "coverage is complete on a cold start");
  assert.equal(coldSnapshots[0].events.length, 0, "the only thing lost is in-flight events");
  // The block belief was in-flight state, so it is legitimately gone — and it
  // will be re-raised by the next hook. Nothing else is missing.
  assert.equal(
    coldSnapshots[0].chats.find((c) => c.sessionId === machine.liveSessionId)?.block,
    undefined,
    "no stale block survives the wipe",
  );
  await cold.stop();

  // --- and the sink is stateless in the same way ---------------------------
  // Unchanged snapshots are skipped; a snapshot carrying events never is.
  let puts = 0;
  const fakeClient = {
    daemon: {
      machines: {
        ":id": {
          "chat-snapshot": {
            $put: async () => {
              puts += 1;
              return {
                ok: true,
                status: 200,
                json: async () => ({ upserted: 1, dead: 0, events: 0, eventsDropped: 0 }),
              };
            },
          },
        },
      },
    },
  };
  let clock = 0;
  const sink = new ChatSnapshotSink({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: fakeClient as any,
    machineId: "33333333-3333-4333-8333-333333333333",
    logger,
    now: () => clock,
    refreshMs: 10_000,
  });
  const snap = coldSnapshots[0];
  await sink.put(snap);
  assert.equal(puts, 1, "first snapshot is sent");
  clock += 1_000;
  await sink.put({ ...snap, observedAt: new Date(clock).toISOString() });
  assert.equal(puts, 1, "an unchanged world is not re-sent every second");
  await sink.put({
    ...snap,
    events: [{ sessionId: "x", harness: "claude", kind: "turn.started", at: new Date().toISOString() }],
  });
  assert.equal(puts, 2, "…but a snapshot carrying events always is");
  clock += 20_000;
  await sink.put(snap);
  assert.equal(puts, 3, "and an unchanged world is refreshed periodically anyway");

  console.log("chat-disposability smoke: OK");
} finally {
  rmSync(paths.cursorsPath, { force: true });
  mkdirSync(paths.eventsDir, { recursive: true });
  machine.cleanup();
}
