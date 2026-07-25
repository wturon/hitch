import assert from "node:assert/strict";

import {
  buildDelegatePreamble,
  closeTarget,
  decideAction,
  deriveObserved,
  observationTransition,
  type ReconcileDecision,
} from "../src/v2/reconciler.js";

// ─── decideAction: desired × observed × hasChat × launchPending → action ─────

const decide = (input: {
  desiredState: "running" | "stopped";
  observedState:
    | "pending"
    | "spawning"
    | "running"
    | "waiting_input"
    | "done"
    | "dead";
  hasChat: boolean;
  launchPending?: boolean;
}) => decideAction({ launchPending: false, ...input });

// desired running.
assert.equal(
  decide({ desiredState: "running", observedState: "pending", hasChat: false }),
  "spawn" satisfies ReconcileDecision,
  "pending + running + no chat → spawn",
);
assert.equal(
  decide({
    desiredState: "running",
    observedState: "pending",
    hasChat: false,
    launchPending: true,
  }),
  "noop",
  "…unless a launch is already in flight — a restart mid-spawn must NOT double-spawn",
);
assert.equal(
  decide({ desiredState: "running", observedState: "pending", hasChat: true }),
  "observe",
  "pending + running WITH a chat → observe (never re-spawn a linked row)",
);
assert.equal(
  decide({ desiredState: "running", observedState: "spawning", hasChat: true }),
  "observe",
  "spawning + running → keep observing (drives spawning→running)",
);
assert.equal(
  decide({ desiredState: "running", observedState: "running", hasChat: true }),
  "observe",
);
assert.equal(
  decide({ desiredState: "running", observedState: "waiting_input", hasChat: true }),
  "observe",
);
assert.equal(
  decide({ desiredState: "running", observedState: "done", hasChat: true }),
  "noop",
  "terminal done → noop",
);
assert.equal(
  decide({ desiredState: "running", observedState: "dead", hasChat: false }),
  "noop",
  "terminal dead → noop",
);

// THE CODEX GAP. Between spawn and the first prompt a codex assignment is
// `spawning` with no chat row, because the thread genuinely doesn't exist yet.
// That is a wait, not a fault — until the launch record ages out, at which
// point it never bound and we say so instead of wedging.
assert.equal(
  decide({
    desiredState: "running",
    observedState: "spawning",
    hasChat: false,
    launchPending: true,
  }),
  "noop",
  "spawning + no chat + launch in flight → wait (the codex bind window)",
);
assert.equal(
  decide({ desiredState: "running", observedState: "spawning", hasChat: false }),
  "fail-launch",
  "spawning + no chat + no launch left → it never bound → dead",
);

// desired stopped (Decision 3 — execute the client's stop intent).
assert.equal(
  decide({ desiredState: "stopped", observedState: "pending", hasChat: false }),
  "mark-done",
  "stopped + pending (never spawned) → done directly",
);
assert.equal(
  decide({ desiredState: "stopped", observedState: "running", hasChat: true }),
  "close",
  "stopped + running WITH chat → close the tab",
);
assert.equal(
  decide({ desiredState: "stopped", observedState: "waiting_input", hasChat: true }),
  "close",
);
assert.equal(
  decide({ desiredState: "stopped", observedState: "spawning", hasChat: true }),
  "close",
);
assert.equal(
  decide({ desiredState: "stopped", observedState: "running", hasChat: false }),
  "mark-done",
  "stopped + running but no live chat → settle to done (nothing to close)",
);
assert.equal(
  decide({
    desiredState: "stopped",
    observedState: "spawning",
    hasChat: false,
    launchPending: true,
  }),
  "mark-done",
  "a stop always wins over a launch still in flight",
);
assert.equal(
  decide({ desiredState: "stopped", observedState: "done", hasChat: true }),
  "noop",
);
assert.equal(
  decide({ desiredState: "stopped", observedState: "dead", hasChat: false }),
  "noop",
);

// ─── deriveObserved: the SERVER chat's state → observed_state ────────────────
//
// Phase D moved this off the local `local_chats` row and onto the two columns
// the snapshot maintains: `status` (derived on the server from the three axes)
// and `existence` (what the machine reports). The assignment's current state is
// the third input, and it is what keeps the honest distinctions.

const claude = (
  status: "busy" | "waiting_input" | "idle" | "dead",
  existence: "running" | "dormant" | "pending" | null,
) => ({ status, existence, harness: "claude" as const });
const codex = (
  status: "busy" | "waiting_input" | "idle" | "dead",
  existence: "running" | "dormant" | "pending" | null,
) => ({ status, existence, harness: "codex" as const });

assert.equal(deriveObserved(claude("busy", "running"), "spawning"), "running", "busy → running");
assert.equal(
  deriveObserved(claude("waiting_input", "running"), "running"),
  "waiting_input",
  "blocked on a human → waiting_input",
);
assert.equal(
  deriveObserved(claude("idle", "running"), "running"),
  "waiting_input",
  "running but idle = the agent finished a pass → waiting_input",
);
assert.equal(
  deriveObserved(claude("idle", "running"), "spawning"),
  null,
  "…but never straight out of spawning: a harness reads idle before its first prompt lands",
);
assert.equal(
  deriveObserved(claude("busy", "pending"), "spawning"),
  null,
  "pending existence = we launched it and it hasn't bound — no transition",
);

// Absence. `dead` on the server means the machine stopped seeing it; whether
// that is `done` or `dead` depends on whether it ever got going.
assert.equal(deriveObserved(claude("dead", null), "waiting_input"), "done", "ran, then ended → done");
assert.equal(deriveObserved(claude("dead", null), "running"), "done");
assert.equal(
  deriveObserved(claude("dead", null), "spawning"),
  "dead",
  "never ran → dead (launch never bound)",
);

// Dormant: the transcript survives, the process doesn't. Concluded for CLAUDE
// only, and only once we've seen it live — codex dormancy is a heuristic, and a
// false "ended" would settle an assignment whose agent is still working.
assert.equal(deriveObserved(claude("idle", "dormant"), "running"), "done", "claude dormant → done");
assert.equal(deriveObserved(claude("idle", "dormant"), "spawning"), null, "…but not from spawning");
assert.equal(
  deriveObserved(codex("idle", "dormant"), "running"),
  null,
  "codex dormancy never concludes an ending",
);
assert.equal(deriveObserved(codex("busy", "running"), "spawning"), "running");

// No chat row at all → dead (nothing was ever bound).
assert.equal(deriveObserved(null, "running"), "dead", "missing chat → dead");

// ─── closeTarget: close resolves through the HANDLE ─────────────────────────

assert.equal(
  closeTarget({ sessionId: "s-1", handle: { kind: "cmux", sessionId: "s-1" } }),
  "s-1",
  "a chat we launched carries the session to close",
);
assert.equal(
  closeTarget({ sessionId: "s-1", handle: { kind: "cmux" } }),
  "s-1",
  "a handle without a session id still falls back to the chat's own",
);
assert.equal(
  closeTarget({ sessionId: "s-1", handle: null }),
  null,
  "a chat with NO handle is not ours to close (§4's accepted asymmetry)",
);
assert.equal(closeTarget(null), null);

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
