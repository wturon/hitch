// V2 todo grouping (M2 PR 2; M4 PR 6 attention queue). The status-driven
// successor to lib/todos.ts's deriveTodoGroups: server tasks carry a real
// `status` column, so there is no frontmatter to parse — grouping is a pure
// fold over the rows the typed hc client returns from GET /tasks. No React, no
// HTTP: unit-testable in isolation, exactly like its V1 counterpart.
//
// The four groups (NEEDS YOU / WORKING / BACKLOG / DONE) split OPEN tasks by
// their latest assignment's observed state (M4). Attention is derived from a
// taskId → latest-assignment map the caller joins client-side; when no map is
// passed, NEEDS YOU and WORKING stay empty and every open task falls to BACKLOG
// (the pre-M4 behavior — kept so the backlog-only callers, e.g. the dialog's
// prepend maths, need no assignment query). DONE always holds `status:"done"`
// tasks regardless of assignment state: marking a task done takes it out of the
// attention queue (close-on-done, Decision 3).

import { selectLatestAssignment, type ObservedState } from "./delegation";

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
   * Open tasks whose latest assignment wants your attention — the PRD queue:
   * `waiting_input` (the agent finished a pass) ∪ `done ∧ reviewed_at null`
   * (the agent finished, not yet acked). sortOrder ascending.
   */
  needsYou: T[];
  /**
   * Open tasks whose latest assignment is still in flight (pending / spawning /
   * running). sortOrder ascending.
   */
  working: T[];
  /** Open tasks with no live/attention assignment, in manual order (sortOrder ascending). */
  backlog: T[];
  /** Done tasks, most recently completed first. */
  done: T[];
}

// Parse an ISO timestamp to an epoch sort key; null/unparseable sinks to the
// bottom of DONE (mirrors V1, where a malformed completed-at falls last).
function completedEpoch(raw: string | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

// Fractional-index strings are plain-ASCII and compare lexicographically —
// use a raw string compare, NOT localeCompare (locale collation can disagree
// with the index math). Ties (two clients minting the same key) break by id;
// uuidv7 is creation-ordered, so the tie order is stable and roughly temporal.
const bySortOrder = (a: TaskRow, b: TaskRow) =>
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
const byCompletedDesc = (a: TaskRow, b: TaskRow) => {
  const diff = (completedEpoch(b.completedAt) ?? 0) - (completedEpoch(a.completedAt) ?? 0);
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

// How a task's latest assignment wants your attention (or "working" while in
// flight). null = no attention (backlog): no assignment, or a terminal `dead`,
// or a `done` that's already been acked (reviewed_at set).
export type AttentionKind = "review" | "input" | "working";

// The attention a task derives from its latest assignment. `review` is the
// ackable case (done ∧ not yet reviewed); `input` clears on its own when the
// agent's state changes (opening the chat is the response). Pure — the queue
// definition lives here.
export function taskAttention(
  latest: Pick<AttentionAssignment, "observedState" | "reviewedAt"> | null | undefined,
): AttentionKind | null {
  if (!latest) return null;
  switch (latest.observedState) {
    case "waiting_input":
      return "input";
    case "done":
      return latest.reviewedAt == null ? "review" : null;
    case "pending":
    case "spawning":
    case "running":
      return "working";
    case "dead":
      return null;
  }
}

// Join assignments to tasks: the latest (by created_at) assignment per task id.
// The daemon only ever acts on a task's most-recent assignment, so the latest
// is the one whose observed state drives attention (older rows are history).
export function latestAssignmentByTaskId<T extends AttentionAssignment>(
  assignments: readonly T[] | undefined,
): Map<string, T> {
  const byTask = new Map<string, T[]>();
  for (const a of assignments ?? []) {
    const list = byTask.get(a.taskId);
    if (list) list.push(a);
    else byTask.set(a.taskId, [a]);
  }
  const latest = new Map<string, T>();
  for (const [taskId, list] of byTask) {
    const chosen = selectLatestAssignment(list);
    if (chosen) latest.set(taskId, chosen);
  }
  return latest;
}

/**
 * Fold a project's tasks into the four attention groups. Generic so callers
 * get their full row type back (title, tagIds, …), not just the sort fields.
 *
 * `latestByTaskId` (M4) is the taskId → latest-assignment map from
 * latestAssignmentByTaskId; when omitted, NEEDS YOU / WORKING stay empty and
 * every open task falls to BACKLOG (the pre-M4 backlog-only behavior).
 */
export function deriveTaskGroups<T extends TaskRow>(
  tasks: T[],
  latestByTaskId?: ReadonlyMap<
    string,
    Pick<AttentionAssignment, "observedState" | "reviewedAt">
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
    const attention = latestByTaskId ? taskAttention(latestByTaskId.get(task.id)) : null;
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
