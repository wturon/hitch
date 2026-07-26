// V2 section grouping. Where todoGroups.ts folds tasks by DERIVED state (their
// latest assignment), this folds them by USER PLACEMENT — the `section_id`
// column the server has carried since M1 and nothing has ever written.
//
// The two are deliberately different in kind, and only one of them may decide
// where a row sits. Sections win: a task stays where you put it, and its
// agent's state is painted onto the row (the harness chip) instead of moving
// it. deriveTaskGroups survives for DONE and for the attention counts the
// sidebar chips read — it just stops driving layout.
//
// No React, no HTTP: unit-testable in isolation, like todoGroups/capture.

import { bySortOrder, byCompletedDesc, type TaskRow } from "./todoGroups";

/**
 * The minimal shape this needs from a server section — a structural subset of
 * what GET /sections returns.
 */
export interface SectionRow {
  id: string;
  name: string;
  /** Fractional-index string; lexicographic order IS section order. */
  sortOrder: string;
}

/** A task row that knows where it was filed. `null` = loose (no section). */
export interface PlacedTask extends TaskRow {
  sectionId: string | null;
}

export interface SectionBucket<T> {
  section: SectionRow;
  /** Open tasks filed here, in manual order. */
  tasks: T[];
}

export interface SectionedTasks<T> {
  /** Open tasks with no section, rendered first with no header. */
  loose: T[];
  /** Every section of the project, in order — INCLUDING empty ones. */
  sections: SectionBucket<T>[];
  /** Done tasks, most recently completed first — one list for the project. */
  done: T[];
}

// Sections sort like tasks do: plain lexicographic compare on the ASCII
// fractional index (never localeCompare — locale collation can disagree with
// the index math), ties broken by uuidv7 id so the order is total and stable.
const bySectionOrder = (a: SectionRow, b: SectionRow) =>
  a.sortOrder < b.sortOrder
    ? -1
    : a.sortOrder > b.sortOrder
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

/**
 * Fold a project's tasks into loose + per-section buckets + done. Generic so
 * callers get their full row type back (title, tagIds, …), not just the
 * placement fields.
 *
 * DONE is pulled out FIRST and stays one project-wide list regardless of where
 * the task was filed: a completed task is a receipt, not structure.
 *
 * An ORPHAN — a task whose `sectionId` names a section that isn't in
 * `sections` — falls back to loose. That is not a hypothetical: DELETE
 * /sections/:id nulls the column server-side, so between the section list
 * refetching and the task list refetching (two independent queries, two WS
 * invalidations) a client holds exactly this state. Rendering the task loose
 * for those few milliseconds is right; dropping it on the floor is not.
 */
export function deriveSectionedTasks<T extends PlacedTask>(
  tasks: readonly T[],
  sections: readonly SectionRow[],
): SectionedTasks<T> {
  const ordered = [...sections].sort(bySectionOrder);
  const buckets = new Map<string, T[]>(ordered.map((s) => [s.id, []]));

  const loose: T[] = [];
  const done: T[] = [];
  for (const task of tasks) {
    if (task.status === "done") {
      done.push(task);
      continue;
    }
    const bucket = task.sectionId === null ? undefined : buckets.get(task.sectionId);
    if (bucket) bucket.push(task);
    else loose.push(task);
  }

  return {
    loose: loose.sort(bySortOrder),
    sections: ordered.map((section) => ({
      section,
      tasks: (buckets.get(section.id) ?? []).sort(bySortOrder),
    })),
    done: done.sort(byCompletedDesc),
  };
}

/**
 * The open tasks of one container, in list order — what a prepend (capture, or
 * unchecking a done row) computes its fractional index against. `sectionId`
 * null means the loose container.
 *
 * Order is only ever compared WITHIN a container, so this deliberately doesn't
 * look at the rest of the project: a new loose task must land above the LOOSE
 * head, not above whatever key happens to be globally smallest.
 *
 * Goes through the same fold as the view rather than filtering on `sectionId`
 * directly, so an orphan (§ deriveSectionedTasks) counts as loose for the
 * placement maths exactly as it does on screen. Filtering directly would put a
 * fresh capture *below* an orphan it appears above.
 */
export function tasksInContainer<T extends PlacedTask>(
  tasks: readonly T[],
  sections: readonly SectionRow[],
  sectionId: string | null,
): T[] {
  const grouped = deriveSectionedTasks(tasks, sections);
  if (sectionId === null) return grouped.loose;
  return grouped.sections.find((b) => b.section.id === sectionId)?.tasks ?? [];
}
