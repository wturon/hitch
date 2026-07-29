// V2 todo grouping (M2 PR 2; M4 PR 6 attention queue). The status-driven
// successor to the removed V1 (Convex-frontmatter) todo derivation: server
// tasks carry a real `status` column, so there is no frontmatter to parse —
// grouping is a pure fold over the rows the typed hc client returns from GET
// /tasks. No React, no HTTP: unit-testable in isolation.
//
// The four groups (NEEDS YOU / WORKING / BACKLOG / DONE) split OPEN tasks by
// the observed state of the agent chats on them (M4). Attention is derived from
// a taskId → chats map the caller joins client-side; with no map, NEEDS YOU and
// WORKING stay empty and every open task falls to BACKLOG. That path stays
// supported because the only map-less callers left are the tests — a caller
// with no assignments query still gets a coherent backlog-only fold rather than
// an error. DONE always holds `status:"done"` tasks regardless of assignment
// state: marking a task done takes it out of the attention queue (close-on-done,
// Decision 3).
//
// MULTI-CHAT (slice 1): a task can carry SEVERAL live assignments at once —
// `assignments` is append-only and per-task, the daemon reconciles each one
// independently, and POST /assignments has no one-live-per-task guard. This
// module used to fold each task down to its NEWEST assignment, which made every
// other agent on the task invisible and — worse — let a row report "Working"
// while a second agent on it sat blocked on the user. So nothing here picks a
// latest any more: a task has a LIST of chats, the row's instrument is the
// most DEMANDING of them (`rowState`), and attention is an ANY-fold over all of
// them (`taskAttentionFromChats`). The row's chrome followed in slice 3: a stack
// of chips, capped at two avatars plus a `+N` (chipStack.ts), whose outer ring is
// `rowState`.

import { type ObservedState } from "./delegation";

/**
 * The minimal shape the grouping needs from a server task — a structural
 * subset of what GET /tasks returns (@hitch/shared Task + tagIds). Date
 * columns cross the wire as ISO-8601 strings; they're compared as parsed
 * epochs, never trusted to sort lexicographically.
 */
export interface TaskRow {
  id: string;
  status: "open" | "done";
  /** Fractional-index string (Figma-style) — lexicographic order IS list order. */
  sortOrder: string;
  /** ISO timestamp; set iff status is "done" (routes/tasks.ts owns the invariant). */
  completedAt: string | null;
}

export interface TaskGroups<T extends TaskRow> {
  /**
   * Open tasks where ANY chat wants your attention — the PRD queue:
   * `waiting_input` (the agent finished a pass) ∪ `done ∧ reviewed_at null`
   * (the agent finished, not yet acked). sortOrder ascending.
   */
  needsYou: T[];
  /**
   * Open tasks with no attention chat but at least one still in flight
   * (pending / spawning / running). sortOrder ascending.
   */
  working: T[];
  /** Open tasks with no live/attention assignment, in manual order (sortOrder ascending). */
  backlog: T[];
  /** Done tasks, most recently completed first. */
  done: T[];
}

// Parse a wire timestamp to an epoch sort key. `null` means "no usable key" —
// for DONE that sinks the row to the bottom (mirrors V1, where a malformed
// completed-at falls last); the chat lanes treat it as 0. The ONE place this
// module turns a date into a number: ISO strings are never trusted to sort
// lexicographically, and `Date` instances arrive from optimistic cache writes.
function parseEpoch(raw: string | Date | null): number | null {
  if (!raw) return null;
  const t = raw instanceof Date ? raw.getTime() : Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

// Fractional-index strings are plain-ASCII and compare lexicographically —
// use a raw string compare, NOT localeCompare (locale collation can disagree
// with the index math). Ties (two clients minting the same key) break by id;
// uuidv7 is creation-ordered, so the tie order is stable and roughly temporal.
export const bySortOrder = (a: TaskRow, b: TaskRow) =>
  a.sortOrder < b.sortOrder
    ? -1
    : a.sortOrder > b.sortOrder
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

// Newest completion first; rows without a parseable completed-at fall to the
// bottom. Exact ties (and the unparseable block) break by id DESC — uuidv7's
// creation order — so the list is a total order and never jumps between
// refetches.
export const byCompletedDesc = (a: TaskRow, b: TaskRow) => {
  const diff = (parseEpoch(b.completedAt) ?? 0) - (parseEpoch(a.completedAt) ?? 0);
  if (diff !== 0) return diff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

// ─── Attention (M4 PR 6) ─────────────────────────────────────────────────────

// The minimal assignment shape the attention fold needs — a structural subset
// of what GET /assignments returns. createdAt/reviewedAt cross the wire as ISO
// strings; observedState mirrors the server pgEnum.
export interface AttentionAssignment {
  id: string;
  taskId: string;
  createdAt: string | Date;
  observedState: ObservedState;
  /** ISO timestamp; non-null once the attention item has been acked. */
  reviewedAt: string | Date | null;
}

// How a task's chats want your attention (or "working" while in flight).
// null = no attention (backlog): no chat, or every chat is terminal `dead`, or
// a `done` that's already been acked (reviewed_at set).
export type AttentionKind = "review" | "input" | "working";

// ─── The chat's state (sections v1) ──────────────────────────────────────────

// What an agent chip shows. `null` = no chip at all (an empty slot): either
// nothing was ever delegated, or the launch died and there is nothing to open.
// Deliberately three states and not five — the chip is the ONLY status
// instrument on the row, so it stays readable at 22px.
export type HarnessChipState = "idle" | "working" | "needs-you";

/**
 * The ONE observed_state → chip mapping in the app. Internal on purpose: every
 * caller now goes through a `TaskChat`, which carries the already-mapped state,
 * so there is no second place a row can decide what an agent's state looks
 * like.
 *
 * Note `done ∧ reviewed → "idle"` rather than null: the chat still exists and
 * cmux can bring it back, so the chip stays as the way in. Only `dead` (the
 * launch never produced a chat) has nothing to open — those are DROPPED from a
 * task's chat list entirely.
 */
function chatState(
  assignment: Pick<AttentionAssignment, "observedState" | "reviewedAt">,
): HarnessChipState | null {
  switch (assignment.observedState) {
    case "pending":
    case "spawning":
    case "running":
      return "working";
    case "waiting_input":
      return "needs-you";
    case "done":
      // The agent finished and nobody has looked yet — the state V1's chip
      // never had, folded in here rather than earning its own row control.
      return assignment.reviewedAt == null ? "needs-you" : "idle";
    case "dead":
      return null;
  }
}

/** One agent chat of a task: its assignment row plus the state it renders as. */
export interface TaskChat<T> {
  assignment: T;
  state: HarnessChipState;
}

// The demand ladder, and the ONLY severity order in this module: how loudly a
// chat is asking for a human. It orders the lane (bands), it reduces to the
// row's single state, and it decides which group the task lands in — those three
// must never disagree, which is why they read the same table.
const DEMAND: Record<HarnessChipState, number> = {
  "needs-you": 0,
  working: 1,
  idle: 2,
};

// Lane order: band by demand (all needs-you, then working, then idle), newest
// first inside a band. Exact createdAt ties break by id DESC — uuidv7 ids are
// creation-ordered — so the lane is a TOTAL order and never reshuffles between
// refetches of the same data.
function byLane<T extends AttentionAssignment>(a: TaskChat<T>, b: TaskChat<T>): number {
  const band = DEMAND[a.state] - DEMAND[b.state];
  if (band !== 0) return band;
  const age =
    (parseEpoch(b.assignment.createdAt) ?? 0) - (parseEpoch(a.assignment.createdAt) ?? 0);
  if (age !== 0) return age;
  const [x, y] = [a.assignment.id, b.assignment.id];
  return x < y ? 1 : x > y ? -1 : 0;
}

/**
 * A task's agent chats, in lane order (see `byLane`). `dead` assignments are
 * dropped: the launch never produced a chat, so there is nothing to open and
 * nothing to say about it.
 *
 * This is the per-task read (the task dialog's lane). The list view wants every
 * task at once — see `chatsByTaskId`, which produces the identical ordering.
 */
export function chatsForTask<T extends AttentionAssignment>(
  assignments: readonly T[] | undefined,
  taskId: string,
): TaskChat<T>[] {
  const chats: TaskChat<T>[] = [];
  for (const assignment of assignments ?? []) {
    if (assignment.taskId !== taskId) continue;
    const state = chatState(assignment);
    if (state === null) continue;
    chats.push({ assignment, state });
  }
  return chats.sort(byLane);
}

/**
 * The same fold for every task in ONE pass over the flat assignment list — what
 * the list view joins its rows against (the successor to
 * latestAssignmentByTaskId, which collapsed each task to its newest row and hid
 * every other agent on it). Values are ordered exactly as `chatsForTask`.
 *
 * A task with only `dead` assignments gets NO entry at all (rather than an empty
 * array), so `map.get(id)` is absent exactly when the row draws no chip.
 */
export function chatsByTaskId<T extends AttentionAssignment>(
  assignments: readonly T[] | undefined,
): Map<string, TaskChat<T>[]> {
  const byTask = new Map<string, TaskChat<T>[]>();
  for (const assignment of assignments ?? []) {
    const state = chatState(assignment);
    if (state === null) continue;
    const chat: TaskChat<T> = { assignment, state };
    const list = byTask.get(assignment.taskId);
    if (list) list.push(chat);
    else byTask.set(assignment.taskId, [chat]);
  }
  for (const list of byTask.values()) list.sort(byLane);
  return byTask;
}

/**
 * The row's single instrument: a REDUCE by demand over all the task's chats,
 * never "the latest". A row must never report "Working" while something on it
 * is blocked on the user — with an append-only assignment list the newest chat
 * is routinely NOT the one that needs a human, so picking by recency silently
 * buried the only state the user had to act on.
 *
 * `null` for an empty or absent list — the empty chip slot.
 */
export function rowState<T>(
  chats: readonly TaskChat<T>[] | undefined,
): HarnessChipState | null {
  let worst: HarnessChipState | null = null;
  for (const chat of chats ?? []) {
    if (worst === null || DEMAND[chat.state] < DEMAND[worst]) worst = chat.state;
  }
  return worst;
}

/**
 * The task's attention: the per-chat mapping (`waiting_input` → "input";
 * `done ∧ unreviewed` → "review"; in-flight → "working"; `dead` and acked-`done`
 * contribute nothing) OR'd across every chat. ANY chat can pull the task into
 * the queue.
 *
 * When chats disagree, attention beats working — the group placement follows the
 * same severity order as `rowState`, so a task whose second agent is blocked
 * cannot hide in WORKING. Between the two attention kinds "input" wins: a live
 * agent waiting on a reply is a conversation stalled right now, whereas a
 * finished-unreviewed one is only waiting to be acked.
 */
export function taskAttentionFromChats<
  T extends Pick<AttentionAssignment, "observedState" | "reviewedAt">,
>(chats: readonly TaskChat<T>[] | undefined): AttentionKind | null {
  let review = false;
  let working = false;
  for (const { assignment } of chats ?? []) {
    switch (assignment.observedState) {
      case "waiting_input":
        // Nothing outranks "input" — no need to look at the rest.
        return "input";
      case "done":
        if (assignment.reviewedAt == null) review = true;
        break;
      case "pending":
      case "spawning":
      case "running":
        working = true;
        break;
      case "dead":
        break;
    }
  }
  return review ? "review" : working ? "working" : null;
}

/**
 * Split a task's lane into what's shown and what's tucked behind "earlier":
 * anything still in play (`needs-you` / `working`) is visible, a finished-and-
 * acked chat (`idle`) is history. Input order is preserved on both sides, so a
 * lane fed by `chatsForTask` keeps its band ordering.
 *
 * Lives here rather than in the dialog so the list row and the dialog's lane
 * share ONE definition of "still in play" — the row's chip is drawn from
 * `rowState`, which is a reduce over the same predicate's inputs.
 */
export function partitionLaneChats<T>(chats: readonly TaskChat<T>[]): {
  visible: TaskChat<T>[];
  earlier: TaskChat<T>[];
} {
  const visible: TaskChat<T>[] = [];
  const earlier: TaskChat<T>[] = [];
  for (const chat of chats) {
    if (chat.state === "idle") earlier.push(chat);
    else visible.push(chat);
  }
  return { visible, earlier };
}

/**
 * Fold a project's tasks into the four attention groups. Generic so callers
 * get their full row type back (title, tagIds, …), not just the sort fields.
 *
 * `chatsByTask` is the taskId → chats map from `chatsByTaskId`. AppV2 passes it —
 * the ⌘K palette's labels ARE this fold. Optional only for the tests: with no
 * map, NEEDS YOU / WORKING stay empty and every open task falls to BACKLOG, so a
 * caller with no assignments query gets a backlog-only fold, not an error.
 */
export function deriveTaskGroups<T extends TaskRow>(
  tasks: T[],
  chatsByTask?: ReadonlyMap<
    string,
    readonly TaskChat<Pick<AttentionAssignment, "observedState" | "reviewedAt">>[]
  >,
): TaskGroups<T> {
  const needsYou: T[] = [];
  const working: T[] = [];
  const backlog: T[] = [];
  const done: T[] = [];
  for (const task of tasks) {
    // Done always wins: a completed task is out of the attention queue.
    if (task.status === "done") {
      done.push(task);
      continue;
    }
    const attention = chatsByTask
      ? taskAttentionFromChats(chatsByTask.get(task.id))
      : null;
    if (attention === "working") working.push(task);
    else if (attention === "review" || attention === "input") needsYou.push(task);
    else backlog.push(task);
  }
  return {
    needsYou: needsYou.sort(bySortOrder),
    working: working.sort(bySortOrder),
    backlog: backlog.sort(bySortOrder),
    done: done.sort(byCompletedDesc),
  };
}
