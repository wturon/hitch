// The list as dnd-kit sees it: ONE flat, ordered array of drop targets running
// the full height of the project — every visible task row, plus every section
// header as a target in its own right.
//
// This is the whole trick, and it is worth stating plainly because the previous
// design did the opposite. A section is not a *container* here; it is a
// *marker*. Which section a task belongs to is not stored during the drag and
// not reconstructed from geometry at the end — it is read off the list the same
// way you read it off the screen: a task is in the section whose header is
// nearest above it. Move the row, look up, done.
//
// That buys the one property the container design could never hold onto:
// `verticalListSortingStrategy` animates the gap, `arrayMove` computes the
// result, and both are the SAME operation on the SAME array. The preview and
// the write cannot disagree, because there is only one answer being computed.
//
// It also deletes, rather than fixes, everything the multi-container version
// needed: per-container droppables, an `onDragOver` that splices the row into
// its destination mid-flight, a forked copy of the list held in state for the
// duration of the drag, and the branch-per-drop-kind at the end.
import { arrayMove } from "@dnd-kit/sortable";

// Header and add-row ids share an id space with task uuids, so they carry
// prefixes that a uuid can't produce.
const HEADER_PREFIX = "section:";
const ADD_PREFIX = "add:";
export const headerSlotId = (sectionId: string) => `${HEADER_PREFIX}${sectionId}`;
export const addSlotId = (sectionId: string | null) => `${ADD_PREFIX}${sectionId ?? ""}`;

export type Slot =
  // A section's header. Everything below it is in that section, until the next
  // one — this is the only thing that decides where a task lives.
  | { kind: "header"; id: string; sectionId: string }
  // A drop target that holds a position but is neither a row nor a boundary:
  // the container's add-row. It exists in this list so that the strip between a
  // header and its first row is a target rather than a hole, which is what lets
  // the hit test be `pointerWithin` alone (see TodosViewV2) — and, because it
  // sits directly under the header, it needs no meaning of its own. "Nearest
  // header above" already reads a drop there as the top of that container.
  | { kind: "anchor"; id: string }
  | { kind: "task"; id: string };

/** A container as the list renders it, top to bottom. `sectionId: null` = loose. */
export type SlotSource = {
  sectionId: string | null;
  /** Open tasks filed here, in render order. */
  taskIds: readonly string[];
  collapsed: boolean;
  /** The add-row's slot id, or null when it isn't rendered (filtering). */
  anchorId?: string | null;
};

/** Where a task ends up: which section, and its index among that section's rows. */
export type Placement = { sectionId: string | null; index: number };

/**
 * Flatten the containers into the drag's item list.
 *
 * The loose container contributes no header — it is simply everything above the
 * first one, which is also what makes "drag a row above the first section" mean
 * "unfile it" without a droppable existing for it.
 *
 * A collapsed section contributes its header and none of its rows: the rows
 * aren't on screen, so they can't be drop targets, but the header still is —
 * dropping on it files into the section you can't see, at the top.
 */
export function buildSlots(containers: readonly SlotSource[]): Slot[] {
  const slots: Slot[] = [];
  for (const container of containers) {
    if (container.sectionId !== null) {
      slots.push({
        kind: "header",
        id: headerSlotId(container.sectionId),
        sectionId: container.sectionId,
      });
    }
    if (container.collapsed) continue;
    if (container.anchorId) slots.push({ kind: "anchor", id: container.anchorId });
    for (const id of container.taskIds) slots.push({ kind: "task", id });
  }
  return slots;
}

/**
 * Where the dragged row lands — the one and only placement computation.
 *
 * `arrayMove(slots, from, to)` is exactly what `verticalListSortingStrategy`
 * just drew, so this reads the arrangement the user is looking at rather than
 * predicting one. Then a single pass down the moved list answers "which section
 * is it in, and how many of that section's rows are above it".
 *
 * `index` counts only rows PRESENT in the flat list, which is what makes the
 * collapsed case fall out for free: a collapsed section contributes no rows, so
 * a drop on its header is index 0 — the top of it.
 *
 * Returns null when nothing moved.
 */
export function placementAfterMove(
  slots: readonly Slot[],
  activeId: string,
  overId: string,
): Placement | null {
  const from = slots.findIndex((slot) => slot.id === activeId);
  const to = slots.findIndex((slot) => slot.id === overId);
  if (from < 0 || to < 0 || from === to) return null;

  const moved = arrayMove(slots as Slot[], from, to);
  let sectionId: string | null = null;
  let index = 0;
  for (const slot of moved) {
    if (slot.kind === "header") {
      sectionId = slot.sectionId;
      index = 0;
      continue;
    }
    if (slot.kind === "anchor") continue;
    if (slot.id === activeId) return { sectionId, index };
    index += 1;
  }
  return null;
}
