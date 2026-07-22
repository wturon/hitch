// Pure sort-order math for the PR 4 list mutations: the uncheck-to-top
// prepend and the drag-reorder neighbor computation. Fractional-index keys
// are plain ASCII, so lexicographic string compares pin list positions.
import { describe, expect, it } from "vitest";
import { generateKeyBetween } from "fractional-indexing";

import { captureSortOrder } from "../capture";
import { reorderSortOrder, uncheckSortOrder } from "../listMutations";

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
