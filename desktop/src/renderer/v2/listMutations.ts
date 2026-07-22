import { generateKeyBetween } from "fractional-indexing";

// Pure sort-order math for the V2 list mutations (M2 PR 4). No React, no
// HTTP — unit-testable in isolation, like capture.ts / todoGroups.ts.
//
// Every mutation here writes ONE task's fractional-index sortOrder; the list
// order is never rewritten wholesale (that was V1's backlogOrders full-replace
// model — V2's schema keys order into the rows themselves).

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
  // Neighbors at the destination, in the CURRENT list, skipping the moved row:
  // moving down lands after backlog[to]; moving up lands before backlog[to].
  const prev = from < to ? backlog[to] : backlog[to - 1];
  const next = from < to ? backlog[to + 1] : backlog[to];
  return generateKeyBetween(prev?.sortOrder ?? null, next?.sortOrder ?? null);
}
