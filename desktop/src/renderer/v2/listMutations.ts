import { generateKeyBetween } from "fractional-indexing";

// Pure sort-order math for the V2 list mutations (M2 PR 4). No React, no
// HTTP — unit-testable in isolation, like capture.ts / todoGroups.ts.
//
// Every mutation here writes ONE task's fractional-index sortOrder; the list
// order is never rewritten wholesale (that was V1's backlogOrders full-replace
// model — V2's schema keys order into the rows themselves).

/**
 * The sortOrder for a row inserted BEFORE `list[index]` (an `index` of
 * `list.length` appends). `list` must be in list order.
 *
 * This exists because DUPLICATE keys within one container are ordinary data
 * here, not a bug to assert against. Every container mints its first key
 * independently (`generateKeyBetween(null, null)` = "a0"), so a task filed into
 * a section and a task captured loose both hold "a0" — and `on delete set null`
 * then merges those two key spaces into one list. fractional-indexing treats an
 * equal pair as a programming error and THROWS, and that throw lands inside
 * dnd-kit's async drag-end handler where nothing catches it: the drop is
 * silently discarded, and so is every later drop near the pair.
 *
 * Widening, not clamping, is what makes this converge. Taking the neighbours
 * literally gives `(a0, a0)`, which can't be split; dropping the upper bound
 * instead — `generateKeyBetween("a0", null)` = "a1" — happily mints a key that
 * COLLIDES with whatever already holds "a1", flinging the row past unrelated
 * rows and breeding a fresh duplicate pair. So we walk `prev` back to the last
 * key strictly below `next`. Because the list is sorted, every key we skip
 * equals `next`, which means the open interval `(prev, next)` provably holds no
 * existing row: the new key is unique, and the row lands directly above the
 * duplicates it was aimed at.
 */
export function sortOrderAtIndex(
  list: ReadonlyArray<{ sortOrder: string }>,
  index: number,
): string {
  const next = list[index]?.sortOrder ?? null;
  let prev: string | null = null;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = list[i].sortOrder;
    if (next === null || candidate < next) {
      prev = candidate;
      break;
    }
  }
  return generateKeyBetween(prev, next);
}

/**
 * The sortOrder for a task returning to the TOP of the backlog — a key BEFORE
 * the current head. Unchecking re-pins the row first (V1's decision: an
 * accidental check must come back where you'll see it, not sink to wherever
 * it used to be), the same prepend math as capture's new-task placement
 * (capture.ts). `backlog` is the open group in list order WITHOUT the task
 * being unchecked (it's in DONE); empty backlog → the first key.
 */
export function uncheckSortOrder(
  backlog: ReadonlyArray<{ sortOrder: string }>,
): string {
  return generateKeyBetween(null, backlog[0]?.sortOrder ?? null);
}

/**
 * The sortOrder for a row dropped INTO a different container.
 *
 * `dest` is the destination's current list in order (it never contains the
 * dragged row — it came from somewhere else). `overTaskId` is the row the drop
 * landed on; the dragged row takes its place, pushing it down. A drop on the
 * container's empty space (`null`, or an id that isn't there any more) appends
 * — that's the only reading of "you dropped it below everything".
 */
export function insertSortOrder(
  dest: ReadonlyArray<{ id: string; sortOrder: string }>,
  overTaskId: string | null,
): string {
  const index = overTaskId === null ? -1 : dest.findIndex((t) => t.id === overTaskId);
  return sortOrderAtIndex(dest, index === -1 ? dest.length : index);
}

/**
 * The sortOrder for a backlog row dragged from index `from` to index `to`
 * (dnd-kit arrayMove semantics: the row lands at index `to` of the reordered
 * list). Computed between the destination's neighbors so the drop is a
 * single-task PATCH. `backlog` is the CURRENT open group in list order.
 * Returns null for a no-op or out-of-range move (the caller skips the PATCH).
 */
export function reorderSortOrder(
  backlog: ReadonlyArray<{ sortOrder: string }>,
  from: number,
  to: number,
): string | null {
  const n = backlog.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return null;
  // dnd-kit's arrayMove semantics: the row ends up at index `to` of the
  // reordered list — i.e. inserted at `to` in the list WITHOUT it.
  const rest = backlog.filter((_, i) => i !== from);
  return sortOrderAtIndex(rest, to);
}
