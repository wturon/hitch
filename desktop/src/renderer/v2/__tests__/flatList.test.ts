// The flat-list drag model: a section is a MARKER in one ordered array, not a
// container. Every assertion here is "given the arrangement the user is looking
// at, where does the row belong" — the same question `arrayMove` answers on
// screen, which is the point of the design.
import { describe, expect, it } from "vitest";

import {
  addSlotId,
  buildSlots,
  headerSlotId,
  placementAfterMove,
  type Slot,
  type SlotSource,
} from "../flatList";

const A = "sec-a";
const B = "sec-b";

/** loose: t1 t2 | A: t3 t4 | B: t5 — with each container's add-row. */
const CONTAINERS: SlotSource[] = [
  { sectionId: null, taskIds: ["t1", "t2"], collapsed: false, anchorId: addSlotId(null) },
  { sectionId: A, taskIds: ["t3", "t4"], collapsed: false, anchorId: addSlotId(A) },
  { sectionId: B, taskIds: ["t5"], collapsed: false, anchorId: addSlotId(B) },
];

const slotsOf = (containers = CONTAINERS) => buildSlots(containers);
const ids = (slots: Slot[]) => slots.map((s) => s.id);

describe("buildSlots", () => {
  it("runs loose rows first with no header, then each section", () => {
    expect(ids(slotsOf())).toEqual([
      addSlotId(null),
      "t1",
      "t2",
      headerSlotId(A),
      addSlotId(A),
      "t3",
      "t4",
      headerSlotId(B),
      addSlotId(B),
      "t5",
    ]);
  });

  it("leaves no hole between a header and its first row", () => {
    // The property the hit test depends on: `pointerWithin` alone is only
    // enough because every band inside a container is a slot. If the add-row
    // ever stops being one, a drop in that strip resolves to nothing.
    const slots = slotsOf();
    const header = slots.findIndex((s) => s.id === headerSlotId(A));
    expect(slots[header + 1].kind).toBe("anchor");
    expect(slots[header + 2].kind).toBe("task");
  });

  it("a collapsed section keeps its header and drops everything else", () => {
    const slots = slotsOf([
      { sectionId: null, taskIds: ["t1"], collapsed: false, anchorId: addSlotId(null) },
      { sectionId: A, taskIds: ["t3", "t4"], collapsed: true, anchorId: addSlotId(A) },
    ]);
    expect(ids(slots)).toEqual([addSlotId(null), "t1", headerSlotId(A)]);
  });

  it("omits the add-rows when they aren't rendered (filtering)", () => {
    const slots = slotsOf(
      CONTAINERS.map((container) => ({ ...container, anchorId: null })),
    );
    expect(slots.some((slot) => slot.kind === "anchor")).toBe(false);
  });

  it("a project with no sections is just the add-row and the rows", () => {
    expect(
      ids(
        slotsOf([
          { sectionId: null, taskIds: ["t1", "t2"], collapsed: false, anchorId: addSlotId(null) },
        ]),
      ),
    ).toEqual([addSlotId(null), "t1", "t2"]);
  });

  it("header and add-row ids can't collide with task ids", () => {
    expect(headerSlotId(A).startsWith("section:")).toBe(true);
    expect(addSlotId(A).startsWith("add:")).toBe(true);
    expect(addSlotId(null)).not.toBe(addSlotId(A));
  });
});

describe("placementAfterMove", () => {
  const place = (activeId: string, overId: string, containers = CONTAINERS) =>
    placementAfterMove(slotsOf(containers), activeId, overId);

  it("reorders within the loose list", () => {
    expect(place("t1", "t2")).toEqual({ sectionId: null, index: 1 });
  });

  it("reorders within a section", () => {
    expect(place("t4", "t3")).toEqual({ sectionId: A, index: 0 });
  });

  it("files a loose row into a section by dropping on one of its rows", () => {
    // Down onto t4 (the last row of A): arrayMove puts it AT t4's slot, so it
    // lands last in A — which is where the gap opened.
    expect(place("t1", "t4")).toEqual({ sectionId: A, index: 2 });
  });

  it("dropping on a header from ABOVE lands first in that section", () => {
    // Dragging down onto a header pushes the header up past the row, so the row
    // comes to rest just below it.
    expect(place("t1", headerSlotId(A))).toEqual({ sectionId: A, index: 0 });
  });

  it("dropping on a header from BELOW lands above it — the section you left", () => {
    // The mirror image, and the reason it needs no special case: the header
    // moves DOWN past the row, so the row ends up before it. This is how a row
    // gets out of a section, and how it becomes loose again.
    expect(place("t3", headerSlotId(A))).toEqual({ sectionId: null, index: 2 });
  });

  it("drags a row all the way out to the top of the project", () => {
    expect(place("t5", "t1")).toEqual({ sectionId: null, index: 0 });
  });

  it("drags a row to the very bottom of the last section", () => {
    // Onto t5, the last row in the project — it comes to rest below it. There
    // is no separate "append" gesture and no end-of-list droppable; the last
    // row IS the target, and dropping past it means after it.
    expect(place("t1", "t5")).toEqual({ sectionId: B, index: 1 });
  });

  it("dropping on a section's ADD-ROW lands first in it, from either side", () => {
    // The add-row is the unambiguous "top of this container" target — it sits
    // below the header, so approach direction can't flip its meaning the way it
    // flips the header's.
    expect(place("t1", addSlotId(A))).toEqual({ sectionId: A, index: 0 });
    expect(place("t5", addSlotId(A))).toEqual({ sectionId: A, index: 0 });
    // Including for a row already in that section, dragged up over its own.
    expect(place("t4", addSlotId(A))).toEqual({ sectionId: A, index: 0 });
  });

  it("an add-row never counts toward a section's row index", () => {
    // t3 is A's first row; landing after it must be index 1, not 2.
    expect(place("t1", "t3")).toEqual({ sectionId: A, index: 1 });
  });

  it("files into a COLLAPSED section at the top", () => {
    const containers = [
      { sectionId: null, taskIds: ["t1", "t2"], collapsed: false, anchorId: addSlotId(null) },
      { sectionId: A, taskIds: ["t3", "t4"], collapsed: true, anchorId: addSlotId(A) },
    ];
    // The collapsed section contributes no rows, so there is nothing to be
    // below — index 0, the top of what's hidden in there.
    expect(place("t1", headerSlotId(A), containers)).toEqual({
      sectionId: A,
      index: 0,
    });
  });

  it("files into an EMPTY section — no droppable of its own required", () => {
    const containers = [
      { sectionId: null, taskIds: ["t1"], collapsed: false, anchorId: addSlotId(null) },
      { sectionId: A, taskIds: [], collapsed: false, anchorId: addSlotId(A) },
    ];
    expect(place("t1", addSlotId(A), containers)).toEqual({ sectionId: A, index: 0 });
    expect(place("t1", headerSlotId(A), containers)).toEqual({ sectionId: A, index: 0 });
  });

  it("is null when nothing moved — a nudge that ends on itself writes nothing", () => {
    expect(place("t1", "t1")).toBeNull();
  });

  it("is null for ids that aren't in the list", () => {
    expect(place("nope", "t1")).toBeNull();
    expect(place("t1", "nope")).toBeNull();
  });

  it("never reports a placement the ARRANGEMENT doesn't show", () => {
    // The load-bearing property, stated as an invariant rather than a case:
    // for every pair, re-deriving the section from the moved array by the same
    // "nearest header above" rule must agree with what we returned. This is the
    // check that would have caught the container design's preview/write drift.
    const slots = slotsOf();
    for (const active of slots.filter((s) => s.kind === "task")) {
      for (const over of slots) {
        const got = placementAfterMove(slots, active.id, over.id);
        if (!got) continue;
        const from = slots.findIndex((s) => s.id === active.id);
        const to = slots.findIndex((s) => s.id === over.id);
        const moved = [...slots];
        moved.splice(to, 0, ...moved.splice(from, 1));
        const at = moved.findIndex((s) => s.id === active.id);
        let headerAt = -1;
        for (let i = at - 1; i >= 0; i--) {
          if (moved[i].kind === "header") {
            headerAt = i;
            break;
          }
        }
        const header = headerAt < 0 ? null : moved[headerAt];
        expect(got.sectionId).toBe(
          header && header.kind === "header" ? header.sectionId : null,
        );
        expect(got.index).toBe(
          moved.slice(headerAt + 1, at).filter((s) => s.kind === "task").length,
        );
      }
    }
  });
});
