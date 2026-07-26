import { generateKeyBetween } from "fractional-indexing";

// Pure sort-order math for the V2 list mutations (M2 PR 4). No React, no
// HTTP — unit-testable in isolation, like capture.ts / todoGroups.ts.
//
// Every mutation here writes ONE task's fractional-index sortOrder; the list
// order is never rewritten wholesale (that was V1's backlogOrders full-replace
// model — V2's schema keys order into the rows themselves).

/**
 * `generateKeyBetween`, but tolerant of a DEGENERATE neighbour pair.
 *
 * Sections made duplicate keys reachable within one container, which the
 * library treats as a programming error: it swaps an out-of-order pair but
 * THROWS on an equal one. Every container mints its first key independently
 * (`generateKeyBetween(null, null)` = "a0"), so a task filed into a section and
 * a task captured loose can hold the same key — and then `on delete set null`
 * merges those two key spaces into one list. The duplicate is legal data the
 * moment a section is deleted, or the moment another client deletes one and our
 * orphan fallback renders those tasks loose.
 *
 * A throw here lands inside dnd-kit's async drag-end handler, where nothing
 * catches it: the drop is silently discarded and every later drop near the pair
 * fails the same way, with nothing on screen to explain it.
 *
 * So when the pair can't be split, we drop the upper bound and land the row
 * immediately AFTER `prev` — which is also after its duplicate, since they're
 * equal. Deterministic, never throws, and puts the row adjacent to where it was
 * aimed.
 */
export function keyBetween(prev: string | null, next: string | null): string {
  if (prev !== null && next !== null && prev >= next) {
    return generateKeyBetween(prev, null);
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
  if (index === -1) return keyBetween(dest.at(-1)?.sortOrder ?? null, null);
  return keyBetween(dest[index - 1]?.sortOrder ?? null, dest[index].sortOrder);
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
  return keyBetween(prev?.sortOrder ?? null, next?.sortOrder ?? null);
}
