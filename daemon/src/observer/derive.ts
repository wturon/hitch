import type { ChatLifecycleStatus } from "../chatLifecycleStore.js";
import type { Observation, ObservedStatus } from "./types.js";

// Map a machine observation to a hitch chat status, ignoring events.
//
//   gone / dormant      → idle    (no live process: ended or resumable-cold)
//   running + working   → working (mid-turn)
//   running + idle      → waiting (turn closed, the user's move — live & warm)
//   running + unknown   → waiting (conservative: can't prove it's working)
//
// `needs-input` is never returned: a permission/question wait is not
// distinguishable from a running tool on disk, so it stays an event overlay
// (see ObservedSource). This is a pure function of the observation.
export function deriveStatusFromObservation(obs: Observation): ObservedStatus {
  if (obs.existence !== "running") return "idle";
  if (obs.activity === "working") return "working";
  return "waiting";
}

export interface DeriveChatStatusInput {
  // The status reduced from the hook/daemon event stream — today's source of
  // truth for `local_chats.status`.
  eventStatus: ChatLifecycleStatus;
  // The latest machine observation, when the observer has one.
  observation: Observation | null;
  // The flip switch. Dark (default): events win, the observation is shadow-only.
  // Flipped (P2, per-harness once validated): the observation drives activity,
  // but `needs-input` from events is preserved (it's the only carrier of the
  // block axis) and a `working` event can still win the leading edge.
  preferObserver?: boolean;
}

export interface DerivedChatStatus {
  status: ChatLifecycleStatus;
  source: "events" | "observer";
}

// The unification seam between the two state sources. P0 ships it dark: with
// `preferObserver` unset it returns the event status verbatim, so wiring it in
// is a no-op. P2 flips a harness to `preferObserver: true` once the
// disagreement log shows the observer is at least as good as the hooks.
export function deriveChatStatus(
  input: DeriveChatStatusInput,
): DerivedChatStatus {
  const { eventStatus, observation, preferObserver } = input;
  if (!preferObserver || !observation) {
    return { status: eventStatus, source: "events" };
  }

  // needs-input is event-only and outranks everything *while the chat is live*:
  // a chat blocked on a prompt reads as `working` (open tool) on disk, so never
  // let the observer downgrade it. A dead process still overrides it below.
  if (eventStatus === "needs-input" && observation.existence === "running") {
    return { status: "needs-input", source: "events" };
  }

  const observed = deriveStatusFromObservation(observation);

  // Existence is hard ground truth: a process that's gone or dormant cannot be
  // working, so the observation overrides a stale `working`/`waiting` event.
  // This is the heal — the "stuck in working forever" fix.
  if (observation.existence !== "running") {
    return { status: observed, source: "observer" };
  }

  // Live chat: leading-edge bias toward `working`. If either source sees an
  // active turn, it's working — keeps the instant hook signal even when the
  // observer's trailing settle hasn't flipped yet.
  if (eventStatus === "working" || observed === "working") {
    return {
      status: "working",
      source: observed === "working" ? "observer" : "events",
    };
  }

  return { status: observed, source: "observer" };
}

// True when the observation contradicts the live (event-derived) status in a
// way worth logging while we run dark. Pure so it can be unit-tested and reused
// by the disagreement log.
export function statusesDisagree(
  eventStatus: ChatLifecycleStatus,
  observation: Observation | null,
): boolean {
  if (!observation) return false;
  const observed = deriveStatusFromObservation(observation);
  // Fold needs-input into working for the comparison: the observer can't see
  // the block axis, so eventStatus=needs-input vs observed=working is agreement.
  const normalizedEvent =
    eventStatus === "needs-input" ? "working" : eventStatus;
  return normalizedEvent !== observed;
}
