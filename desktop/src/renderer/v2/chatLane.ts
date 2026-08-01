// Pure logic for the delegate bar's CHAT LANE (multi-chat slice 2). No React, no
// HTTP — the house shape of todoGroups/delegation/tagFilter, so every wording and
// visibility rule below is unit-tested instead of eyeballed inside the bar.
//
// What the lane IS — its order, and the visible/earlier split — comes from
// todoGroups (`chatsForTask` / `partitionLaneChats`, slice 1). What lives here is
// the lane's LIFECYCLE policy: the per-row agent line, the status+age line, which
// action a row has earned, the launch that never started, and whether machines
// are worth naming at all. Each one is a decision with branches; the lane's plain
// wording (its counts, its button labels) is inlined at its call site in
// ChatLane.tsx / DelegateBar.tsx, where a pluralising ternary reads better than an
// import.
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
  /** Set when this assignment ADOPTED an already-running chat. */
  requestedChatId: string | null;
}

/**
 * The row's second line: a short status, then how long ago the chat STARTED.
 *
 * The age is deliberately worded "started 4m ago" and never a bare "4m":
 * `created_at` is the one timestamp we actually have here, and a bare age next to
 * a live status reads as last activity — which would be a lie about an agent
 * that has been quiet for an hour.
 *
 * Two labels the chip mapping can't produce:
 *
 * The in-flight stop: between `desired_state = stopped` and the reconciler
 * closing the tab, the observed state still says "Working". Saying so would be
 * true-but-useless; the user just asked for the opposite.
 *
 * The in-flight LINK: `pending`/`spawning` render as "Spawning…", which is a
 * plain lie about an adopted chat — nothing is being spawned, the session was
 * already running and the daemon is only confirming it. The chip mapping keys on
 * observed_state alone and structurally cannot tell the two apart, so the
 * distinction is made here, where the assignment's intent is in scope.
 */
export function chatStatusLine(assignment: LaneStatusFields, now: number): string {
  const terminal =
    assignment.observedState === "done" || assignment.observedState === "dead";
  const adopting =
    assignment.requestedChatId !== null &&
    (assignment.observedState === "pending" || assignment.observedState === "spawning");
  const status =
    assignment.desiredState === "stopped" && !terminal
      ? "Stopping…"
      : adopting
        ? "Linking…"
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

// ─── Can we actually reach this chat? ────────────────────────────────────────

/**
 * Whether Hitch can bring a chat forward (and close it), given the chat's
 * `handle` — attachment 2 in docs/chat-tracking-redesign.md §4.
 *
 * The handle is stamped by the attachment layer on chats the daemon LAUNCHED. A
 * chat that was merely discovered on the machine — which is every chat the
 * "Link a chat" picker offers — has none, so the focus relay logs "observed
 * here, not launched here" and returns (daemon/src/v2/focus.ts), and the close
 * path finds nothing to close. That asymmetry is accepted by design; what is NOT
 * acceptable is a control that renders enabled and does nothing at all, which is
 * exactly what linking made reachable for the first time.
 *
 * `null` is the ONLY answer that disables anything: it is the server positively
 * reporting a chat with no handle. `undefined` — the chats query hasn't landed,
 * or this chat isn't in it yet — stays reachable, because unknown must not
 * degrade into a dead button on a chat we did launch. It corrects itself the
 * moment the query settles.
 */
export function chatIsFocusable(handle: unknown): boolean {
  return handle !== null;
}

/**
 * What the live row's button says. "Stop" promises to end the agent; for a chat
 * Hitch cannot close, the PATCH only settles the assignment and lets go of the
 * chat — so the button says the thing that actually happens.
 */
export function laneStopLabel(focusable: boolean): "Stop" | "Unlink" {
  return focusable ? "Stop" : "Unlink";
}

/**
 * The Open-chat tooltip, which is the only place the asymmetry is explained.
 * Keyed on useOpenChat's `blockedBy` so the words and the disabled state can
 * never disagree — they read the same value.
 */
export function openChatHint(blockedBy: "not-started" | "no-handle" | null): string {
  if (blockedBy === "not-started") return "Waiting for the agent’s chat to start…";
  if (blockedBy === "no-handle") {
    return "Hitch didn’t launch this chat, so it can’t bring it forward";
  }
  return "Bring the chat forward in cmux";
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
