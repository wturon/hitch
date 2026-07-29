// Pure logic for the delegate bar's CHAT LANE (multi-chat slice 2). No React, no
// HTTP — the house shape of todoGroups/delegation/tagFilter, so every wording and
// visibility rule below is unit-tested instead of eyeballed inside the bar.
//
// What the lane IS — its order, and the visible/earlier split — comes from
// todoGroups (`chatsForTask` / `partitionLaneChats`, slice 1). What lives here is
// what the lane SAYS: the per-row agent line, the status+age line, which action a
// row has earned, whether machines are worth naming at all, and the compose
// block's two decisions (does it start expanded, and what does its button say).
//
// The status vocabulary is NOT re-invented: labels come from
// `observedStateChip`, the same mapping the bar has always used, and the ring's
// three-state vocabulary comes from `TaskChat.state`. This module only adds the
// two things the lane needs and a single chip could never say: the age, and the
// in-flight stop.

import {
  formatLastSeen,
  modelLabelFor,
  observedStateChip,
  reasoningLabelFor,
  type DesiredState,
  type ObservedState,
  type ServerHarness,
} from "./delegation";

// ─── Line 1: which agent, on what settings ───────────────────────────────────

/** The minimal assignment shape the agent line needs. */
export interface LaneAgentFields {
  harness: ServerHarness;
  /** Kickoff model; null for a chat the daemon never launched. */
  model: string | null;
  /** Kickoff reasoning effort; null when the launch didn't pin one. */
  effort: string | null;
  /** Set when this assignment ADOPTED an already-running chat. */
  requestedChatId: string | null;
}

/**
 * The trailing detail on a row's first line: the launch params this chat was
 * started with — or the honest admission that Hitch never chose any.
 *
 * A chat linked from a terminal (`requested_chat_id` set, no model) was already
 * running when it was attached to the task: the daemon didn't spawn it, so there
 * is no model or effort to report, and printing the harness default would be a
 * lie about a session the user started by hand.
 */
export function chatAgentDetail(assignment: LaneAgentFields): string {
  if (assignment.model === null) {
    return assignment.requestedChatId !== null
      ? "linked from terminal"
      : "default model";
  }
  const model = modelLabelFor(assignment.harness, assignment.model);
  if (assignment.effort === null) return model;
  return `${model} · ${reasoningLabelFor(assignment.harness, assignment.effort, assignment.model)}`;
}

// ─── Line 2: status + age ────────────────────────────────────────────────────

/** The minimal assignment shape the status line needs. */
export interface LaneStatusFields {
  desiredState: DesiredState;
  observedState: ObservedState;
  createdAt: string | Date;
}

/**
 * The row's second line: a short status, then how long ago the chat STARTED.
 *
 * The age is deliberately worded "started 4m ago" and never a bare "4m":
 * `created_at` is the one timestamp we actually have here, and a bare age next to
 * a live status reads as last activity — which would be a lie about an agent
 * that has been quiet for an hour.
 *
 * The one label the chip mapping can't produce is the in-flight stop: between
 * `desired_state = stopped` and the reconciler closing the tab, the observed
 * state still says "Working". Saying so would be true-but-useless; the user just
 * asked for the opposite.
 */
export function chatStatusLine(assignment: LaneStatusFields, now: number): string {
  const terminal =
    assignment.observedState === "done" || assignment.observedState === "dead";
  const status =
    assignment.desiredState === "stopped" && !terminal
      ? "Stopping…"
      : observedStateChip(assignment.observedState).label;
  return `${status} · started ${formatLastSeen(assignment.createdAt, now)}`;
}

// ─── The row's action ────────────────────────────────────────────────────────

/**
 * The single action a row offers on its right edge:
 *   stop   — the chat is live and wanted running; the user can end it.
 *   review — it finished and nobody has acked it: the ONE thing left to do is
 *            say you looked (PATCH reviewed_at), which is also what drops it out
 *            of the attention queue.
 *   none   — nothing actionable: already acked, already stopping, or dead.
 */
export type LaneRowAction = "stop" | "review" | "none";

export function laneRowAction(
  assignment: Pick<LaneStatusFields, "desiredState" | "observedState"> & {
    reviewedAt: string | Date | null;
  },
): LaneRowAction {
  if (assignment.observedState === "done") {
    return assignment.reviewedAt == null ? "review" : "none";
  }
  if (assignment.observedState === "dead") return "none";
  // A stop already in flight has no second act — the row says "Stopping…".
  return assignment.desiredState === "stopped" ? "none" : "stop";
}

// ─── The launch that never started ───────────────────────────────────────────

/** The minimal assignment shape the dead-launch notice needs. */
export interface LaneDeadFields {
  id: string;
  taskId: string;
  createdAt: string | Date;
  observedState: ObservedState;
}

function epoch(value: string | Date): number {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The one thing the lane structurally cannot say. `chatsForTask` DROPS `dead`
 * assignments — correctly, since a launch that never produced a chat has nothing
 * to open and nothing to report a status for — so a failed delegate would
 * otherwise vanish without a word, and the user would be left looking at a
 * compose block with no idea their last attempt died. (The old one-slot bar said
 * "The last agent didn't start."; it could, because it rendered off the latest
 * assignment rather than off the chat list.)
 *
 * Hence: read the RAW assignment list, not the lane. Returns the sentence when
 * the task's most recent assignment is `dead` and nothing is in play, else null.
 *
 * Deliberately conditioned on an empty lane: while another agent is working the
 * user has something live to look at, and a stale failure line above it would
 * compete with the row that matters. It is also NOT the lane's problem to
 * archive — the next successful delegate makes it disappear on its own.
 */
export function deadLaunchNotice(
  assignments: readonly LaneDeadFields[] | undefined,
  taskId: string,
  visibleCount: number,
): string | null {
  if (visibleCount > 0) return null;
  let latest: LaneDeadFields | null = null;
  for (const assignment of assignments ?? []) {
    if (assignment.taskId !== taskId) continue;
    if (latest === null) {
      latest = assignment;
      continue;
    }
    const delta = epoch(assignment.createdAt) - epoch(latest.createdAt);
    // Ties break by id DESC — uuidv7 ids are creation-ordered, so this is the
    // same total order the lane sorts by (todoGroups' byLane).
    if (delta > 0 || (delta === 0 && assignment.id > latest.id)) latest = assignment;
  }
  return latest?.observedState === "dead" ? "The last agent didn’t start." : null;
}

// ─── Machine chrome ──────────────────────────────────────────────────────────

/**
 * Whether machine names are worth showing at all. One machine is the norm, and
 * repeating its name down every row is chrome that carries no information; the
 * moment two chats sit on different machines, WHERE becomes part of what the row
 * is telling you.
 *
 * Read over the WHOLE lane (visible + earlier), not just the visible band: the
 * earlier rows are the same kind of row, and an earlier chat that ran on a third
 * machine has to be able to say so — otherwise expanding the disclosure silently
 * relabels history as "here".
 */
export function laneSpansMachines(
  chats: readonly { assignment: { machineId: string } }[],
): boolean {
  const seen = new Set<string>();
  for (const chat of chats) {
    seen.add(chat.assignment.machineId);
    if (seen.size > 1) return true;
  }
  return false;
}

// ─── Wording + the compose block's two decisions ─────────────────────────────

/**
 * The lane's header count, or null when there are no rows to count. Counts the
 * VISIBLE chats only — the earlier disclosure carries its own count, and a
 * header that folded both in would name a number the rows below it don't add up
 * to.
 */
export function laneCountLabel(visibleCount: number): string | null {
  if (visibleCount <= 0) return null;
  return `${visibleCount} chat${visibleCount === 1 ? "" : "s"}`;
}

/** The earlier-chats disclosure. */
export function earlierChatsLabel(count: number): string {
  return `${count} earlier chat${count === 1 ? "" : "s"}`;
}

/**
 * Does compose start open? Yes exactly when nothing is in play — a fresh task,
 * or one whose chats have all finished. That preserves the pre-multi-chat
 * ergonomics for the common case (open a task, type, ⌘⏎) while a task that
 * already has agents on it leads with THEM and keeps compose one click away.
 *
 * Keyed on the VISIBLE chats, like every other lane decision: finished-and-acked
 * history behind the disclosure is not a reason to hide the delegate affordance.
 */
export function composeStartsExpanded(visibleCount: number): boolean {
  return visibleCount === 0;
}

/**
 * The primary button's label. "Delegate" is the first hand-off of a task;
 * once the lane holds a chat, the same button is ADDING an agent alongside the
 * ones already there — it never replaces or supersedes them, and the word has to
 * say so.
 */
export function primaryActionLabel(visibleCount: number): "Delegate" | "Add agent" {
  return visibleCount === 0 ? "Delegate" : "Add agent";
}

/**
 * Stop-all is a bulk action, so it only earns its place when there is a bulk to
 * act on: two or more chats that would actually be stopped. With one, the row's
 * own Stop is the same click with a clearer target. The SET comes from
 * `assignmentsToStopOnDone` — the lane never re-derives "live and not terminal".
 */
export function showsStopAll(stoppableIds: readonly string[]): boolean {
  return stoppableIds.length >= 2;
}
