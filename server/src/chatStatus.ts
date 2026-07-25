import type { chatActivity, chatBlock, chatExistence, chatStatus } from "./db/schema.js";

// The status function. `status = f(existence, activity, block)` — pure, total,
// and the ONLY place a chat status is decided (docs/chat-tracking-redesign.md
// §3/§5). The daemon reports the three axes; it never decides.
//
// Unit-tested over the full matrix in __tests__/chatStatus.test.ts.

export type ChatExistence = (typeof chatExistence.enumValues)[number];
export type ChatActivity = (typeof chatActivity.enumValues)[number];
export type ChatBlock = (typeof chatBlock.enumValues)[number];
export type ChatStatus = (typeof chatStatus.enumValues)[number];

export interface ChatAxes {
  /** Null = we have no live observation: absent from the snapshot, or swept. */
  existence: ChatExistence | null;
  activity: ChatActivity | null;
  /** Null = not blocked. */
  block: ChatBlock | null;
}

/**
 * Derive the rendered status from the three observation axes.
 *
 * | existence | activity        | block   | status        |
 * | --------- | --------------- | ------- | ------------- |
 * | null      | any             | any     | dead          |
 * | pending   | any             | any     | busy          |
 * | dormant   | any             | any     | idle          |
 * | running   | any             | present | waiting_input |
 * | running   | working         | null    | busy          |
 * | running   | idle/unknown/–  | null    | idle          |
 *
 * Three rules are load-bearing and deliberate:
 *
 * 1. `unknown` activity resolves to **idle**, never busy. Idle beats guessing
 *    working — a wrong "busy" is the failure mode that made the old model
 *    show a working agent that had already died.
 * 2. `block` is only honoured while the process is `running`. A block never
 *    outlives the process that raised it, so a dormant chat with a stale
 *    permission event is idle, not waiting.
 * 3. Existence dispatches first. `pending` (we launched it, it hasn't bound
 *    yet) is busy — it is spawning — regardless of the other two axes, which
 *    have nothing to observe yet.
 */
export function deriveChatStatus({ existence, activity, block }: ChatAxes): ChatStatus {
  // Absent from the snapshot / swept: absence means dead. The sweep in
  // PUT /chat-snapshot clears existence, which lands here on any later read.
  if (existence === null) return "dead";
  if (existence === "pending") return "busy";
  if (existence === "dormant") return "idle";
  // existence === "running"
  if (block !== null) return "waiting_input";
  if (activity === "working") return "busy";
  return "idle";
}
