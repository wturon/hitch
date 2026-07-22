// V2 todo grouping (M2 PR 2). The status-driven successor to lib/todos.ts's
// deriveTodoGroups: server tasks carry a real `status` column, so there is no
// frontmatter to parse — grouping is a pure fold over the rows the typed hc
// client returns from GET /tasks. No React, no HTTP: unit-testable in
// isolation, exactly like its V1 counterpart.
//
// The four-group scaffolding (NEEDS YOU / WORKING / BACKLOG / DONE) is kept on
// purpose: the V2 list renders the same attention-group presentation as V1, but
// until M4 lands machines/assignments there is no chat state to derive from, so
// NEEDS YOU and WORKING are always empty (and the view hides empty groups).

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
  /** Empty until M4 (attention/assignment state doesn't exist yet). */
  needsYou: T[];
  /** Empty until M4. */
  working: T[];
  /** Open tasks in manual order (sortOrder ascending). */
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

/**
 * Fold a project's tasks into the four attention groups. Generic so callers
 * get their full row type back (title, tagIds, …), not just the sort fields.
 */
export function deriveTaskGroups<T extends TaskRow>(tasks: T[]): TaskGroups<T> {
  return {
    needsYou: [],
    working: [],
    backlog: tasks.filter((t) => t.status === "open").sort(bySortOrder),
    done: tasks.filter((t) => t.status === "done").sort(byCompletedDesc),
  };
}
