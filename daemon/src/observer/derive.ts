import type { ChatLifecycleStatus } from "../chatLifecycleStore.js";
import type {
  Observation,
  ObservedExistence,
  ObservedStatus,
} from "./types.js";

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

export interface ResolveChatStatusInput {
  // The status reduced from the hook/daemon event stream, or null when no event
  // has ever bound this row (a wide-discovery, observer-only chat).
  eventStatus: ChatLifecycleStatus | null;
  // The observer's derived status + existence for this chat, or null when the
  // observer hasn't seen it. `observedStatus` is `deriveStatusFromObservation`.
  observedStatus: ChatLifecycleStatus | null;
  observedExistence: ObservedExistence | null;
  // The flip switch. Dark (default): events own status, the observation is
  // shadow-only. Flipped (P2, per-harness once validated): the observation
  // drives activity, `needs-input` from events is preserved, and a dead process
  // overrides a stale event.
  preferObserver?: boolean;
}

export interface ResolvedChatStatus {
  status: ChatLifecycleStatus;
  source: "events" | "observer";
}

// THE single status-ownership policy. Everything that materializes
// `local_chats.status` — the reducer (event-backed rows) and `recordObservation`
// (observer-only rows) — routes through here, so status is owned in exactly one
// place instead of split across the store and the reducer.
//
// Dark (default `preferObserver` false) is a pure passthrough of the event
// status, so wiring it into the reducer is a no-op: the dead-process heal still
// works because it flows through the event stream (a `session.ended` event),
// not through this function. A row with no events is owned entirely by its
// observation (that's the only source it has).
export function resolveChatStatus(
  input: ResolveChatStatusInput,
): ResolvedChatStatus {
  const { eventStatus, observedStatus, observedExistence, preferObserver } =
    input;

  // Observer-only row (wide discovery): the observation is the sole source.
  if (eventStatus === null) {
    return { status: observedStatus ?? "waiting", source: "observer" };
  }

  // Dark, or nothing observed yet: events own the status.
  if (!preferObserver || observedStatus === null) {
    return { status: eventStatus, source: "events" };
  }

  // --- Flipped (P2): the observation drives activity. ---
  // needs-input is event-only and survives while the chat is live (an open tool
  // reads as `working` on disk, so the observer can't see the block).
  if (eventStatus === "needs-input" && observedExistence === "running") {
    return { status: "needs-input", source: "events" };
  }
  // Existence is hard ground truth: a gone/dormant process can't be working, so
  // the observation overrides a stale `working`/`waiting` event (the heal).
  if (observedExistence && observedExistence !== "running") {
    return { status: observedStatus, source: "observer" };
  }
  // Live: leading-edge bias toward working.
  if (eventStatus === "working" || observedStatus === "working") {
    return {
      status: "working",
      source: observedStatus === "working" ? "observer" : "events",
    };
  }
  return { status: observedStatus, source: "observer" };
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
