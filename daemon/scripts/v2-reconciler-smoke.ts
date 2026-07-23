import assert from "node:assert/strict";

import {
  buildDelegatePreamble,
  decideAction,
  deriveObserved,
  observationTransition,
  type ReconcileDecision,
} from "../src/v2/reconciler.js";

// ─── decideAction: the diff table (desired × observed × hasChat → action) ─────

// desired running.
assert.equal(
  decideAction({ desiredState: "running", observedState: "pending", hasChat: false }),
  "spawn" satisfies ReconcileDecision,
  "pending + running + no chat → spawn",
);
assert.equal(
  decideAction({ desiredState: "running", observedState: "pending", hasChat: true }),
  "observe",
  "pending + running WITH a chat → observe (never re-spawn a linked row)",
);
assert.equal(
  decideAction({ desiredState: "running", observedState: "spawning", hasChat: true }),
  "observe",
  "spawning + running → keep observing (drives spawning→running)",
);
assert.equal(
  decideAction({ desiredState: "running", observedState: "running", hasChat: true }),
  "observe",
);
assert.equal(
  decideAction({ desiredState: "running", observedState: "waiting_input", hasChat: true }),
  "observe",
);
assert.equal(
  decideAction({ desiredState: "running", observedState: "done", hasChat: true }),
  "noop",
  "terminal done → noop",
);
assert.equal(
  decideAction({ desiredState: "running", observedState: "dead", hasChat: false }),
  "noop",
  "terminal dead → noop",
);
// A spawning row that somehow lost its chat link → don't blindly re-spawn.
assert.equal(
  decideAction({ desiredState: "running", observedState: "spawning", hasChat: false }),
  "noop",
);

// desired stopped (Decision 3 — execute the client's stop intent).
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "pending", hasChat: false }),
  "mark-done",
  "stopped + pending (never spawned) → done directly",
);
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "running", hasChat: true }),
  "close",
  "stopped + running WITH chat → close the tab",
);
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "waiting_input", hasChat: true }),
  "close",
);
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "spawning", hasChat: true }),
  "close",
);
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "running", hasChat: false }),
  "mark-done",
  "stopped + running but no live chat → settle to done (nothing to close)",
);
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "done", hasChat: true }),
  "noop",
);
assert.equal(
  decideAction({ desiredState: "stopped", observedState: "dead", hasChat: false }),
  "noop",
);

// ─── deriveObserved: chat ground-truth → observed_state ───────────────────────

assert.equal(deriveObserved({ status: "working", endedAt: null }), "running", "busy → running");
assert.equal(
  deriveObserved({ status: "waiting", endedAt: null }),
  "waiting_input",
  "waiting (turn complete) → waiting_input",
);
assert.equal(
  deriveObserved({ status: "needs-input", endedAt: null }),
  "waiting_input",
  "needs-input (blocked) → waiting_input",
);
// endedAt takes precedence over any live status → done (spawned and ended).
assert.equal(deriveObserved({ status: "working", endedAt: 123 }), "done", "ended → done");
assert.equal(deriveObserved({ status: "idle", endedAt: 123 }), "done");
// Live-idle (no endedAt) is ambiguous → no transition.
assert.equal(deriveObserved({ status: "idle", endedAt: null }), null, "live-idle → no transition");
// Missing store row → dead (launch never bound).
assert.equal(deriveObserved(null), "dead", "missing chat → dead");

// ─── observationTransition: transition-only PATCH gate (no redundant PATCH) ───

assert.equal(
  observationTransition("spawning", "running"),
  "running",
  "spawning→running is a real transition",
);
assert.equal(
  observationTransition("running", "running"),
  null,
  "running→running is NOT re-patched (idempotent)",
);
assert.equal(
  observationTransition("running", null),
  null,
  "a null derivation (live-idle) never patches",
);
assert.equal(observationTransition("waiting_input", "done"), "done");
assert.equal(observationTransition("running", "waiting_input"), "waiting_input");

// ─── buildDelegatePreamble: wording parity with the desktop builder ───────────

const withBody = buildDelegatePreamble({ id: "t-1", title: "Ship it", body: "do the thing" });
assert.ok(withBody.includes('You\'re picking up the Hitch task "Ship it".'));
assert.ok(withBody.includes("Here is the full task description, verbatim:"));
assert.ok(withBody.includes("do the thing"), "body embedded verbatim");
assert.ok(withBody.includes("Task id: t-1"));
assert.ok(withBody.includes("run `hitch --help`"));

const noBody = buildDelegatePreamble({ id: "t-2", title: "Empty", body: "   " });
assert.ok(noBody.includes("(No description was written.)"), "blank body → placeholder");

// The exact string the desktop's composeDelegatePrompt produces for a
// blank prompt (preamble only) — pins byte-for-byte parity.
const expected = [
  'You\'re picking up the Hitch task "Empty".',
  "",
  "Here is the full task description, verbatim:",
  "",
  "(No description was written.)",
  "",
  "Task id: t-2",
  "If the `hitch` CLI is installed, you can use it to read this task, add" +
    " comments, and mark it complete — run `hitch --help` to see how.",
].join("\n");
assert.equal(noBody, expected, "preamble is byte-identical to the desktop builder");

console.log("v2-reconciler smoke: OK");
