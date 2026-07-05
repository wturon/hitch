import type { DelegationRequest } from "@/lib/chat";

// The todo dialog's saved-stage footer configurations (Todos v1, slice 5). The
// capture stage owns "coaching"/"coaching-armed" (see CaptureFooter); once
// saved, the footer is keyed off the draft's chat/request/completed state so an
// existing todo opens on the right band. These mirror today's DelegationBand
// states (linked / requested / failed) plus the two net-new todo cases
// (compose, and the completed footer that has no artboard — see below).
//
//   compose          — no chat, no request, not completed → the delegate panel.
//   linked           — a chat is attached (chat-id) → chip + Open chat.
//   requested        — `chat-request: requested` → Requested pill + Cancel.
//   failed           — `chat-request: failed` → Failed pill + Retry.
//   linked-completed — completed AND a chat is linked → the linked band with the
//                      chip ghosted (~35%), matching how DONE rows ghost chips.
//   none             — completed with NO chat → no footer band at all.
export type SavedFooterState =
  | "compose"
  | "linked"
  | "requested"
  | "failed"
  | "linked-completed"
  | "none";

// Pick the saved-stage footer, evaluated top-down (first match wins). Kept pure
// (booleans in, enum out) so the selection is unit-testable in isolation; the
// caller derives `completed` (completed-at populated, or the legacy `status:
// done` compat) and `hasChat` (parseChatRef non-null) from the live draft.
//
// Precedence note: completed wins over an attached chat (Decision 7's DONE
// predicate is checked before the chat predicates), and an attached chat wins
// over a lingering request (matching DelegationBand, which renders the linked
// band before the requested one). In practice a bound chat and a request flag
// are mutually exclusive — the daemon clears the request on bind.
export function selectSavedFooterState(input: {
  hasChat: boolean;
  request: DelegationRequest | null;
  completed: boolean;
}): SavedFooterState {
  const { hasChat, request, completed } = input;
  if (completed) return hasChat ? "linked-completed" : "none";
  if (hasChat) return "linked";
  if (request) return request.state === "failed" ? "failed" : "requested";
  return "compose";
}
