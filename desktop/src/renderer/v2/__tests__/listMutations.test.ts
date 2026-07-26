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
  it("splits an ordinary gap", () => {
    const list = [{ sortOrder: "a1" }, { sortOrder: "a3" }];
    const key = sortOrderAtIndex(list, 1);
    expect(key > "a1" && key < "a3").toBe(true);
  });

  it("appends past the end", () => {
    const list = [{ sortOrder: "a1" }];
    expect(sortOrderAtIndex(list, 1) > "a1").toBe(true);
  });

  it("does not throw on duplicates, and does not collide with an existing key", () => {
    // Reachable data: every container mints its first key independently, so a
    // loose task and a filed one both hold "a0" — then `on delete set null`
    // merges those key spaces. Naively dropping the upper bound here would mint
    // "a1", which the list already contains.
    const list = [
      { sortOrder: "a0" },
      { sortOrder: "a0" },
      { sortOrder: "a1" },
      { sortOrder: "a2" },
    ];
    expect(() => generateKeyBetween("a0", "a0")).toThrow();
    const key = sortOrderAtIndex(list, 1);
    expect(list.some((row) => row.sortOrder === key)).toBe(false);
    expect(key < "a0").toBe(true); // above both duplicates, where it was aimed
  });

  it("converges — inserting repeatedly at a duplicate pair never collides", () => {
    const list = [{ sortOrder: "a0" }, { sortOrder: "a0" }, { sortOrder: "a1" }];
    for (let i = 0; i < 5; i++) {
      const key = sortOrderAtIndex(list, 1);
      expect(list.some((row) => row.sortOrder === key)).toBe(false);
      list.splice(1, 0, { sortOrder: key });
      list.sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1));
    }
  });

  it("keeps a drag over duplicate keys from throwing", () => {
    const rows = [
      { id: "dup-a", sortOrder: "a0" },
      { id: "dup-b", sortOrder: "a0" },
      { id: "tail", sortOrder: "Zz" },
    ];
    expect(() => reorderSortOrder(rows, 2, 1)).not.toThrow();
    expect(() => insertSortOrder(rows, "dup-b")).not.toThrow();
  });
});
