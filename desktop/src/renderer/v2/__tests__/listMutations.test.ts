// Pure sort-order math for the PR 4 list mutations: the uncheck-to-top
// prepend and the drag-reorder neighbor computation. Fractional-index keys
// are plain ASCII, so lexicographic string compares pin list positions.
import { describe, expect, it } from "vitest";
import { generateKeyBetween } from "fractional-indexing";

import { captureSortOrder } from "../capture";
import {
  insertSortOrder,
  reorderSortOrder,
  sortOrderAtIndex,
  uncheckSortOrder,
} from "../listMutations";

describe("uncheckSortOrder", () => {
  it("mints the first key for an empty backlog", () => {
    expect(uncheckSortOrder([])).toBe(generateKeyBetween(null, null));
  });

  it("prepends BEFORE the current backlog head", () => {
    const key = uncheckSortOrder([{ sortOrder: "a1" }, { sortOrder: "a2" }]);
    expect(key < "a1").toBe(true);
  });

  it("is the same prepend math as a fresh capture (one 'top of backlog')", () => {
    const backlog = [{ sortOrder: "a0" }, { sortOrder: "a4" }];
    expect(uncheckSortOrder(backlog)).toBe(captureSortOrder(backlog));
  });

  it("keeps prepending as unchecks stack up (each new head sorts first)", () => {
    let backlog: { sortOrder: string }[] = [{ sortOrder: "a0" }];
    for (let i = 0; i < 3; i++) {
      const key = uncheckSortOrder(backlog);
      expect(key < backlog[0].sortOrder).toBe(true);
      backlog = [{ sortOrder: key }, ...backlog];
    }
  });
});

describe("reorderSortOrder", () => {
  const backlog = [
    { sortOrder: "a0" },
    { sortOrder: "a1" },
    { sortOrder: "a2" },
    { sortOrder: "a3" },
  ];

  it("moving down lands between the destination and its next neighbor", () => {
    const key = reorderSortOrder(backlog, 0, 2);
    expect(key).not.toBeNull();
    expect(key! > "a2" && key! < "a3").toBe(true);
  });

  it("moving up lands between the destination and its previous neighbor", () => {
    const key = reorderSortOrder(backlog, 3, 1);
    expect(key).not.toBeNull();
    expect(key! > "a0" && key! < "a1").toBe(true);
  });

  it("moving to the top mints a key before the head", () => {
    const key = reorderSortOrder(backlog, 2, 0);
    expect(key).not.toBeNull();
    expect(key! < "a0").toBe(true);
  });

  it("moving to the bottom mints a key after the tail", () => {
    const key = reorderSortOrder(backlog, 1, 3);
    expect(key).not.toBeNull();
    expect(key! > "a3").toBe(true);
  });

  it("adjacent swaps in both directions stay between the right neighbors", () => {
    const down = reorderSortOrder(backlog, 1, 2);
    expect(down! > "a2" && down! < "a3").toBe(true);
    const up = reorderSortOrder(backlog, 2, 1);
    expect(up! > "a0" && up! < "a1").toBe(true);
  });

  it("returns null for a no-op or out-of-range move (caller skips the PATCH)", () => {
    expect(reorderSortOrder(backlog, 1, 1)).toBeNull();
    expect(reorderSortOrder(backlog, -1, 2)).toBeNull();
    expect(reorderSortOrder(backlog, 0, 4)).toBeNull();
    expect(reorderSortOrder([], 0, 0)).toBeNull();
  });
});

describe("insertSortOrder", () => {
  const dest = [
    { id: "a", sortOrder: "a1" },
    { id: "b", sortOrder: "a2" },
    { id: "c", sortOrder: "a3" },
  ];

  // Assert on WHERE the row lands, not on the key string.
  const landing = (over: string | null) => {
    const key = insertSortOrder(dest, over);
    return [...dest, { id: "moved", sortOrder: key }]
      .sort((x, y) => (x.sortOrder < y.sortOrder ? -1 : 1))
      .map((t) => t.id);
  };

  it("takes the place of the row it was dropped on, pushing it down", () => {
    expect(landing("b")).toEqual(["a", "moved", "b", "c"]);
  });

  it("lands first when dropped on the head", () => {
    expect(landing("a")).toEqual(["moved", "a", "b", "c"]);
  });

  it("appends when dropped on the container's empty space", () => {
    expect(landing(null)).toEqual(["a", "b", "c", "moved"]);
  });

  it("appends when the row it was dropped on has since vanished", () => {
    expect(landing("gone")).toEqual(["a", "b", "c", "moved"]);
  });

  it("handles a drop into an empty section", () => {
    expect(typeof insertSortOrder([], null)).toBe("string");
    expect(typeof insertSortOrder([], "anything")).toBe("string");
  });
});

describe("sortOrderAtIndex — duplicate keys", () => {
  // Duplicate keys within one container are ordinary data: every container
  // mints its first key independently ("a0"), and `on delete set null` then
  // merges two key spaces into one list.
  const RUN = ["a0", "a1", "a1", "a2", "a3"];
  const rows = (keys: string[]) =>
    keys.map((sortOrder, i) => ({ id: `t${i}`, sortOrder }));

  // Apply a computed key and re-sort, so assertions read as "where did it land"
  // rather than "what string came out" — and so a key that changes NOTHING
  // shows up as the no-op it is.
  const land = (keys: string[], from: number, to: number) => {
    const list = rows(keys);
    const key = reorderSortOrder(list, from, to);
    expect(key).not.toBeNull();
    return list
      .map((row, i) => (i === from ? { ...row, sortOrder: key! } : row))
      .sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : a.sortOrder > b.sortOrder ? 1 : 0))
      .map((row) => row.id);
  };

  it("splits an ordinary gap", () => {
    const key = sortOrderAtIndex([{ sortOrder: "a1" }, { sortOrder: "a3" }], 1);
    expect(key > "a1" && key < "a3").toBe(true);
  });

  it("appends past the end", () => {
    expect(sortOrderAtIndex([{ sortOrder: "a1" }], 1) > "a1").toBe(true);
  });

  it("never mints a key an existing row already holds", () => {
    // Naively dropping the upper bound here returns "a1" — which this list
    // already contains, twice.
    expect(() => generateKeyBetween("a1", "a1")).toThrow();
    const list = rows(RUN);
    for (let i = 0; i <= list.length; i++) {
      for (const bias of ["before", "after"] as const) {
        const key = sortOrderAtIndex(list, i, bias);
        expect(list.some((row) => row.sortOrder === key)).toBe(false);
      }
    }
  });

  // A run of equal keys admits no key BETWEEN its members, so a move landing
  // inside one can't be pixel-exact — it lands at the near end of the run. What
  // it must never do is fail to move: widening the wrong way returns the key
  // the row already holds, and the drag reads as broken.
  it("moves DOWN into a run of equal keys instead of silently no-opping", () => {
    const after = land(RUN, 0, 1);
    expect(after).not.toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(after.indexOf("t0")).toBeGreaterThan(after.indexOf("t1"));
  });

  it("moves UP into a run of equal keys", () => {
    const after = land(RUN, 3, 2);
    expect(after).not.toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(after.indexOf("t3")).toBeLessThan(after.indexOf("t2"));
  });

  it("converges — repeated inserts at a duplicate pair never collide", () => {
    const list = [{ sortOrder: "a0" }, { sortOrder: "a0" }, { sortOrder: "a1" }];
    for (let i = 0; i < 5; i++) {
      const key = sortOrderAtIndex(list, 1);
      expect(list.some((row) => row.sortOrder === key)).toBe(false);
      list.push({ sortOrder: key });
      list.sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
    }
  });

  it("clamps an out-of-range index rather than throwing", () => {
    expect(() => sortOrderAtIndex(rows(RUN), 99)).not.toThrow();
    expect(() => sortOrderAtIndex(rows(RUN), -3)).not.toThrow();
    expect(() => sortOrderAtIndex([], 0)).not.toThrow();
  });

  it("keeps a cross-container drop over duplicates from throwing", () => {
    expect(() => insertSortOrder(rows(RUN), "t2")).not.toThrow();
  });
});
