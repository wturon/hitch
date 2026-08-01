// The "All tasks" fold: every task the user owns, across every project, as ONE
// flat list. Where sectionGroups.ts folds a single project by user placement,
// this deliberately throws placement away — no sections, no headers, no drag —
// and returns two arrays. No React, no HTTP: unit-testable in isolation.
//
// THE ORDER: project name, then that project's own manual order.
//
// A list with no group headers still needs a reason for its order, or it reads
// as shuffled. Sorting by project name gives one without drawing anything:
// same-project rows land next to each other, so the clustering that headers
// would have supplied comes from the content instead of from a rule across the
// page. Inside each run, the manual order the user dragged their tasks into
// survives intact — the same `bySortOrder` the project view renders, so a run
// here is a contiguous slice of that project's list, not a re-derivation of it.
//
// It is also exactly what `hitch tasks list` already prints when no project is
// scoped (cli/src/commands/tasks.ts sorts by resolved project name and leans on
// a stable sort to keep the server's manual order within each name). Desktop and
// CLI therefore agree about what "all my tasks" looks like without either being
// taught about the other.
//
// DONE is the exception, and it is not an oversight: a completed task is a
// receipt, and receipts read chronologically. `done` is one list ordered by
// completion across ALL projects — grouping it by project would bury the thing
// you just finished under a project name starting with "a".

import { bySortOrder, byCompletedDesc, type TaskRow } from "./todoGroups";

/** A task row that knows which project it came from. */
export interface ProjectTask extends TaskRow {
  projectId: string;
}

export interface AllTasks<T> {
  /** Open tasks: project name A→Z, then that project's manual order. */
  open: T[];
  /** Done tasks, most recently completed first — across every project. */
  done: T[];
}

/**
 * projectId → name. A Map rather than a resolver callback because the call site
 * already holds the projects query and builds this once per render; a callback
 * would only wrap the same lookup in a closure it has to memoize anyway.
 */
export type ProjectNames = ReadonlyMap<string, string>;

/**
 * Order two tasks by project name, then by the project's manual order.
 *
 * Project names are human words, so they compare with `localeCompare` — the one
 * place in the ordering machinery that does. (Fractional-index keys never may:
 * see `bySortOrder`, where locale collation can disagree with the index math.)
 *
 * Equal names do NOT mean the same project — two projects can genuinely share a
 * name, and a locale collation calls more pairs equal than a byte compare does.
 * So the name tie breaks on `projectId` (plain compare; ids are opaque, not
 * words) BEFORE `bySortOrder` runs. Without that, two same-named projects would
 * interleave their manual orders into one run rather than sitting as two.
 *
 * UNKNOWN PROJECT IDS sink to the bottom, together, in id then sortOrder order.
 * A task whose project can't be resolved is a transient truth, not a broken row:
 * the projects query and the tasks query invalidate independently, so a client
 * holds exactly this state for a few milliseconds after a project is created or
 * deleted. It must not crash and must not vanish (a task you can still open is
 * the only way back to it), but it has no name to cluster by, so it doesn't
 * claim the top of the list. Same instinct as `byCompletedDesc`, where a row
 * with no usable key falls last.
 */
export function byProjectThenOrder(names: ProjectNames) {
  return (a: ProjectTask, b: ProjectTask): number => {
    const nameA = names.get(a.projectId);
    const nameB = names.get(b.projectId);
    // Band the unresolvable to the bottom before any name comparison happens.
    if (nameA === undefined || nameB === undefined) {
      if (nameA !== undefined) return -1;
      if (nameB !== undefined) return 1;
    } else {
      const byName = nameA.localeCompare(nameB);
      if (byName !== 0) return byName;
    }
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
    return bySortOrder(a, b);
  };
}

/**
 * Fold every task the user owns into the flat cross-project list. Generic so
 * callers get their full row type back (title, tagIds, …), not just the sort
 * fields — same shape `deriveSectionedTasks` returns, minus the structure.
 *
 * Never mutates its input: both arrays are freshly built and sorted in place.
 */
export function deriveAllTasks<T extends ProjectTask>(
  tasks: readonly T[],
  projectNames: ProjectNames,
): AllTasks<T> {
  const open: T[] = [];
  const done: T[] = [];
  for (const task of tasks) {
    if (task.status === "done") done.push(task);
    else open.push(task);
  }
  return {
    open: open.sort(byProjectThenOrder(projectNames)),
    done: done.sort(byCompletedDesc),
  };
}
