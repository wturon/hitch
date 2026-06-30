import assert from "node:assert/strict";

import {
  deriveStatusFromObservation,
  resolveChatStatus,
  statusesDisagree,
} from "../src/observer/derive.js";
import {
  activityFromPidfileStatus,
  deriveClaudeTranscriptActivity,
} from "../src/observer/claudeObserver.js";
import { deriveCodexRolloutActivity } from "../src/observer/codexObserver.js";
import type { Observation } from "../src/observer/types.js";

function obs(overrides: Partial<Observation>): Observation {
  return {
    harness: "claude-code",
    chatId: "session-1",
    host: "host-1",
    cwd: "/tmp/project",
    projectId: "project-1",
    environment: null,
    existence: "running",
    activity: "working",
    pid: 100,
    title: null,
    observedAt: 1_800_000_000_000,
    source: "claude-pidfile",
    evidence: {},
    ...overrides,
  };
}

// --- deriveStatusFromObservation -------------------------------------------
assert.equal(
  deriveStatusFromObservation(obs({ existence: "running", activity: "working" })),
  "working",
);
assert.equal(
  deriveStatusFromObservation(obs({ existence: "running", activity: "idle" })),
  "waiting",
  "running + idle = waiting (the user's turn, still warm)",
);
assert.equal(
  deriveStatusFromObservation(obs({ existence: "running", activity: "unknown" })),
  "waiting",
  "unknown activity on a live chat is conservative, never working",
);
assert.equal(
  deriveStatusFromObservation(obs({ existence: "dormant", activity: "idle" })),
  "idle",
);
assert.equal(
  deriveStatusFromObservation(obs({ existence: "gone", activity: "working" })),
  "idle",
  "a gone process can never be working",
);

// --- resolveChatStatus (the single ownership seam) -------------------------
// Observer-only row (no events) is owned entirely by the observation.
assert.deepEqual(
  resolveChatStatus({
    eventStatus: null,
    observedStatus: "working",
    observedExistence: "running",
  }),
  { status: "working", source: "observer" },
);
// Dark (default): the event status always wins, observation is shadow-only.
assert.deepEqual(
  resolveChatStatus({
    eventStatus: "working",
    observedStatus: "idle",
    observedExistence: "gone",
  }),
  { status: "working", source: "events" },
  "dark mode never lets the observation override events (heal flows via events)",
);
// Flipped: observation drives, but needs-input (event-only) is preserved.
assert.deepEqual(
  resolveChatStatus({
    eventStatus: "needs-input",
    observedStatus: "working",
    observedExistence: "running",
    preferObserver: true,
  }),
  { status: "needs-input", source: "events" },
);
// Flipped: a dead process heals a stuck "working" event.
assert.deepEqual(
  resolveChatStatus({
    eventStatus: "working",
    observedStatus: "idle",
    observedExistence: "gone",
    preferObserver: true,
  }),
  { status: "idle", source: "observer" },
);
// Flipped: leading-edge working bias — either source seeing a turn wins.
assert.equal(
  resolveChatStatus({
    eventStatus: "waiting",
    observedStatus: "working",
    observedExistence: "running",
    preferObserver: true,
  }).status,
  "working",
);

// --- statusesDisagree -------------------------------------------------------
assert.equal(statusesDisagree("working", null), false, "no observation = agree");
assert.equal(
  statusesDisagree("working", obs({ existence: "gone" })),
  true,
  "hook says working, observer says idle → disagree",
);
assert.equal(
  statusesDisagree("needs-input", obs({ activity: "working" })),
  false,
  "needs-input folds into working for the comparison",
);

// --- Claude activity derivation --------------------------------------------
assert.equal(activityFromPidfileStatus("busy"), "working");
assert.equal(activityFromPidfileStatus("idle"), "idle");
assert.equal(activityFromPidfileStatus(null), "unknown");
assert.equal(activityFromPidfileStatus("weird"), "unknown");

assert.equal(
  deriveClaudeTranscriptActivity([
    '{"type":"user","message":{"role":"user"}}',
    '{"type":"assistant","message":{"stop_reason":"end_turn"}}',
    // trailing metadata lines must be ignored
    '{"type":"ai-title","aiTitle":"Some title"}',
    '{"type":"permission-mode","mode":"default"}',
  ]).activity,
  "idle",
  "closed turn under trailing metadata = idle",
);
assert.equal(
  deriveClaudeTranscriptActivity([
    '{"type":"assistant","message":{"stop_reason":"tool_use"}}',
  ]).activity,
  "working",
  "open tool_use = working",
);
assert.equal(
  deriveClaudeTranscriptActivity([
    '{"type":"assistant","message":{"stop_reason":"end_turn"}}',
    '{"type":"user","message":{"role":"user"}}',
  ]).activity,
  "working",
  "a fresh user turn after a close = working",
);
assert.equal(
  deriveClaudeTranscriptActivity(['{"type":"ai-title","aiTitle":"x"}']).activity,
  "unknown",
  "no message line in the window = unknown",
);
// A half-written trailing JSON line must not throw or derail derivation.
assert.equal(
  deriveClaudeTranscriptActivity([
    '{"type":"assistant","message":{"stop_reason":"tool_use"}}',
    '{"type":"assist', // partial
  ]).activity,
  "working",
);

// --- Codex activity derivation ---------------------------------------------
assert.equal(
  deriveCodexRolloutActivity([
    '{"type":"event_msg","payload":{"type":"task_started"}}',
    '{"type":"event_msg","payload":{"type":"task_complete"}}',
  ]).activity,
  "idle",
);
assert.equal(
  deriveCodexRolloutActivity([
    '{"type":"event_msg","payload":{"type":"task_complete"}}',
    '{"type":"event_msg","payload":{"type":"task_started"}}',
    '{"type":"response_item","payload":{"type":"function_call"}}',
  ]).activity,
  "working",
  "open tool call in the newest turn = working",
);
assert.equal(
  deriveCodexRolloutActivity([
    '{"type":"event_msg","payload":{"type":"agent_message"}}',
    '{"type":"response_item","payload":{"type":"turn_aborted"}}',
  ]).activity,
  "idle",
);
assert.equal(
  deriveCodexRolloutActivity([
    '{"type":"response_item","payload":{"type":"function_call"}}',
    '{"type":"event_msg","payload":{"type":"token_count"}}', // ambiguous → skip
  ]).activity,
  "working",
  "token_count is skipped, the prior decisive marker wins",
);
assert.equal(
  deriveCodexRolloutActivity([
    '{"type":"session_meta","payload":{"id":"x"}}',
  ]).activity,
  "unknown",
);

console.log("observer-derive-smoke: OK");
