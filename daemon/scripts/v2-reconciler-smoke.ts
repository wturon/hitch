import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AttachmentLayer } from "../src/attachment/index.js";
import {
  closeTarget,
  decideAction,
  deriveObserved,
  existingChatAttachmentPatch,
  observationTransition,
  Reconciler,
  type ReconcileDecision,
} from "../src/v2/reconciler.js";
import type { HitchClient } from "../src/v2/serverClient.js";
import { SerialLoop } from "../src/v2/serialLoop.js";

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
  hasRequestedChat?: boolean;
  launchPending?: boolean;
}) => decideAction({ launchPending: false, hasRequestedChat: false, ...input });

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
    hasRequestedChat: true,
  }),
  "attach" satisfies ReconcileDecision,
  "requested existing chat → attach, never spawn",
);
assert.equal(
  decide({
    desiredState: "running",
    observedState: "spawning",
    hasChat: false,
    hasRequestedChat: true,
  }),
  "attach",
  "a resumed attach request still attaches rather than entering the launch gap",
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

// ─── existing chat attachment: adopt as genuinely running ───────────────────

assert.deepEqual(
  existingChatAttachmentPatch("codex", {
    id: "chat-pending",
    harness: "codex",
    existence: "pending",
  }),
  { chatId: "chat-pending", observedState: "running" },
  "a pre-registered chat cannot leave the assignment stuck pending",
);
assert.deepEqual(
  existingChatAttachmentPatch("claude", {
    id: "chat-dormant",
    harness: "claude",
    existence: "dormant",
  }),
  { chatId: "chat-dormant", observedState: "running" },
  "a stale dormant observation cannot complete the assignment during attach",
);
assert.equal(
  existingChatAttachmentPatch("codex", {
    id: "chat-stale",
    harness: "codex",
    existence: null,
  }),
  null,
  "an aged-out chat is visible but not attachable",
);
assert.equal(
  existingChatAttachmentPatch("codex", {
    id: "chat-wrong-harness",
    harness: "claude",
    existence: "running",
  }),
  null,
  "harness identity must agree",
);

async function reconcileRequestedChat(
  harness: "claude" | "codex",
  existence: "pending" | "dormant",
): Promise<Record<string, unknown>> {
  let resolvePatch!: (patch: Record<string, unknown>) => void;
  const patched = new Promise<Record<string, unknown>>((resolve) => {
    resolvePatch = resolve;
  });
  const client = {
    assignments: {
      $get: async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "assignment-existing",
            taskId: "task-1",
            machineId: "machine-1",
            harness,
            prompt: null,
            model: null,
            effort: null,
            desiredState: "running",
            observedState: "pending",
            requestedChatId: "chat-existing",
            chatId: null,
          },
        ],
      }),
    },
    daemon: {
      chats: {
        $get: async () => ({
          ok: true,
          status: 200,
          json: async () => [
            {
              id: "chat-existing",
              harness,
              sessionId: "session-existing",
              status: "idle",
              existence,
              handle: null,
            },
          ],
        }),
      },
      assignments: {
        ":id": {
          $patch: async (input: { json: Record<string, unknown> }) => {
            resolvePatch(input.json);
            return { ok: true, status: 200 };
          },
        },
      },
    },
  } as unknown as HitchClient;
  const attachments = {
    sweep: () => [],
    resolveLinks: async () => {},
    pendingLaunches: () => new Set<string>(),
  } as unknown as AttachmentLayer;
  const reconciler = new Reconciler({
    client,
    attachments,
    machineId: "machine-1",
    host: "smoke-host",
    tickMs: 60_000,
    logger: { info: () => {} },
    resolveLauncher: () => undefined,
  });
  reconciler.start();
  try {
    return await Promise.race([
      patched,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("existing-chat reconcile timed out")), 1_000),
      ),
    ]);
  } finally {
    reconciler.stop();
  }
}

assert.deepEqual(
  await reconcileRequestedChat("codex", "pending"),
  { chatId: "chat-existing", observedState: "running" },
  "the real reconcile path attaches pending chats as running",
);
assert.deepEqual(
  await reconcileRequestedChat("claude", "dormant"),
  { chatId: "chat-existing", observedState: "running" },
  "the real reconcile path never completes a dormant chat during attach",
);

// ─── Shared serialized-loop contract ───────────────────────────────────────
let releaseFirst!: () => void;
let signalFirst!: () => void;
let signalSecond!: () => void;
const firstStarted = new Promise<void>((resolve) => {
  signalFirst = resolve;
});
const release = new Promise<void>((resolve) => {
  releaseFirst = resolve;
});
const secondFinished = new Promise<void>((resolve) => {
  signalSecond = resolve;
});
let passes = 0;
const loop = new SerialLoop({
  intervalMs: 60_000,
  pass: async () => {
    passes += 1;
    if (passes === 1) {
      signalFirst();
      await release;
    } else {
      signalSecond();
    }
  },
  onError: (error) => {
    throw error;
  },
});
loop.start();
await firstStarted;
loop.trigger("mid-pass");
releaseFirst();
await secondFinished;
loop.stop();
assert.equal(passes, 2, "a mid-pass trigger schedules exactly one trailing pass");

// ─── The daemon composes NO prompt ───────────────────────────────────────────
//
// There used to be a buildDelegatePreamble here, a hand-maintained copy of the
// desktop's builder ("keep the wording identical", said the comment). Prompts
// are now resolved once by the server at assignment creation, so the reconciler
// only ever reads assignments.prompt. Guard the regression: nothing in the
// reconciler may reconstruct prompt text.
const reconcilerSource = readFileSync(
  new URL("../src/v2/reconciler.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(
  reconcilerSource,
  /You're picking up the Hitch task/,
  "the daemon must never compose prompt text — the server owns resolution",
);
assert.doesNotMatch(
  reconcilerSource,
  /buildDelegatePreamble/,
  "buildDelegatePreamble is deleted, not re-exported",
);

console.log("v2-reconciler smoke: OK");
