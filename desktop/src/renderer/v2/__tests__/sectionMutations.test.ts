import { describe, expect, it } from "vitest";

import {
  appendSectionSortOrder,
  stepSectionSortOrder,
} from "../useSectionMutations";

// Sections are ordered by the same fractional index tasks are, so the only
// thing worth testing here is the maths: does a move land the section where the
// menu item says it will, and do the ends refuse rather than compute nonsense.

const list = (...keys: string[]) => keys.map((sortOrder) => ({ sortOrder }));

// Apply a computed key and re-sort, so assertions read as "where did it land"
// rather than "what string came out".
function reorder(keys: string[], index: number, direction: "up" | "down") {
  const next = stepSectionSortOrder(list(...keys), index, direction);
  if (next === null) return null;
  const moved = keys.map((k, i) => ({ name: `s${i}`, sortOrder: i === index ? next : k }));
  return moved.sort((a, b) => (a.sortOrder < b.sortOrder ? -1 : 1)).map((s) => s.name);
}

describe("appendSectionSortOrder", () => {
  it("puts a new section at the END — it is a place you're about to fill", () => {
    const key = appendSectionSortOrder(list("a1", "a2"));
    expect(key > "a2").toBe(true);
  });

  it("handles the first section of a project", () => {
    expect(typeof appendSectionSortOrder([])).toBe("string");
  });
});

describe("stepSectionSortOrder", () => {
  it("moves a section up exactly one place", () => {
    expect(reorder(["a1", "a2", "a3"], 2, "up")).toEqual(["s0", "s2", "s1"]);
  });

  it("moves a section down exactly one place", () => {
    expect(reorder(["a1", "a2", "a3"], 0, "down")).toEqual(["s1", "s0", "s2"]);
  });

  it("moves the second section above the head", () => {
    expect(reorder(["a1", "a2", "a3"], 1, "up")).toEqual(["s1", "s0", "s2"]);
  });

  it("moves the second-to-last below the tail", () => {
    expect(reorder(["a1", "a2", "a3"], 1, "down")).toEqual(["s0", "s2", "s1"]);
  });

  it("refuses at the ends rather than computing a no-op key", () => {
    expect(stepSectionSortOrder(list("a1", "a2"), 0, "up")).toBeNull();
    expect(stepSectionSortOrder(list("a1", "a2"), 1, "down")).toBeNull();
  });

  it("refuses an out-of-range index (a section that just vanished)", () => {
    expect(stepSectionSortOrder(list("a1"), -1, "up")).toBeNull();
    expect(stepSectionSortOrder(list("a1"), 5, "down")).toBeNull();
  });

  it("is a no-op-safe single move in a one-section project", () => {
    expect(stepSectionSortOrder(list("a1"), 0, "up")).toBeNull();
    expect(stepSectionSortOrder(list("a1"), 0, "down")).toBeNull();
  });
});
