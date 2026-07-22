// @vitest-environment jsdom
// The V2 tag filter (PR 5): AND semantics + exclusive Untagged over resolved
// tag names, the facet-count preview math, and the per-project localStorage
// persistence — the pure port of V1's lib/todos filter section onto server
// rows (tagIds → names).
import { beforeEach, describe, expect, it } from "vitest";

import { deriveTaskGroups } from "../todoGroups";
import {
  EMPTY_TAG_FILTER,
  filterTaskGroups,
  loadTagFilter,
  saveTagFilter,
  tagFacetCounts,
  taskMatchesTagFilter,
} from "../tagFilter";

describe("taskMatchesTagFilter", () => {
  it("matches everything when the filter is inactive", () => {
    expect(taskMatchesTagFilter([], EMPTY_TAG_FILTER)).toBe(true);
    expect(taskMatchesTagFilter(["bug"], EMPTY_TAG_FILTER)).toBe(true);
  });

  it("AND semantics: the task must carry EVERY selected tag", () => {
    const f = { tags: ["bug", "urgent"], untagged: false };
    expect(taskMatchesTagFilter(["bug", "urgent", "ui"], f)).toBe(true);
    expect(taskMatchesTagFilter(["bug"], f)).toBe(false);
    expect(taskMatchesTagFilter([], f)).toBe(false);
  });

  it("untagged matches only zero-tag tasks", () => {
    const f = { tags: [], untagged: true };
    expect(taskMatchesTagFilter([], f)).toBe(true);
    expect(taskMatchesTagFilter(["bug"], f)).toBe(false);
  });
});

// A minimal task row + its resolved names, for the group projection.
const task = (id: string, status: "open" | "done", names: string[]) => ({
  id,
  status,
  sortOrder: id,
  completedAt: status === "done" ? "2026-07-01T00:00:00.000Z" : null,
  names,
});
const namesOf = (t: { names: string[] }) => t.names;

describe("filterTaskGroups", () => {
  const rows = [
    task("a", "open", ["bug"]),
    task("b", "open", ["bug", "urgent"]),
    task("c", "open", []),
    task("d", "done", ["bug", "urgent"]),
  ];
  const groups = deriveTaskGroups(rows);

  it("returns the SAME object when the filter is inactive", () => {
    expect(filterTaskGroups(groups, EMPTY_TAG_FILTER, namesOf)).toBe(groups);
  });

  it("projects every group through the AND filter (done included)", () => {
    const filtered = filterTaskGroups(
      groups,
      { tags: ["bug", "urgent"], untagged: false },
      namesOf,
    );
    expect(filtered.backlog.map((t) => t.id)).toEqual(["b"]);
    expect(filtered.done.map((t) => t.id)).toEqual(["d"]);
  });

  it("untagged keeps only zero-tag rows", () => {
    const filtered = filterTaskGroups(
      groups,
      { tags: [], untagged: true },
      namesOf,
    );
    expect(filtered.backlog.map((t) => t.id)).toEqual(["c"]);
    expect(filtered.done).toEqual([]);
  });
});

describe("tagFacetCounts", () => {
  const universe = [["bug"], ["bug", "urgent"], [], ["bug", "urgent"]];

  it("with no filter: plain per-tag counts + the untagged count", () => {
    const counts = tagFacetCounts(universe, EMPTY_TAG_FILTER);
    expect(counts.byTag.get("bug")).toBe(3);
    expect(counts.byTag.get("urgent")).toBe(2);
    expect(counts.untagged).toBe(1);
  });

  it("previews ADDING each unchecked tag to the current AND selection", () => {
    const counts = tagFacetCounts(universe, { tags: ["urgent"], untagged: false });
    // bug row alone doesn't match urgent∧bug; only the two urgent+bug rows do.
    expect(counts.byTag.get("bug")).toBe(2);
    // A checked tag shows the CURRENT match count (re-adding is a no-op).
    expect(counts.byTag.get("urgent")).toBe(2);
  });

  it("a tag no task carries is absent (callers default to 0)", () => {
    const counts = tagFacetCounts(universe, EMPTY_TAG_FILTER);
    expect(counts.byTag.has("ghost")).toBe(false);
  });

  it("an Untagged filter counts tags against a cleared base (switch preview)", () => {
    const counts = tagFacetCounts(universe, { tags: [], untagged: true });
    expect(counts.byTag.get("bug")).toBe(3);
    expect(counts.untagged).toBe(1);
  });
});

describe("tag filter persistence (per project, localStorage)", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a filter per project id", () => {
    saveTagFilter("p1", { tags: ["bug"], untagged: false });
    saveTagFilter("p2", { tags: [], untagged: true });
    expect(loadTagFilter("p1")).toEqual({ tags: ["bug"], untagged: false });
    expect(loadTagFilter("p2")).toEqual({ tags: [], untagged: true });
  });

  it("saving the empty filter clears the stored key", () => {
    saveTagFilter("p1", { tags: ["bug"], untagged: false });
    saveTagFilter("p1", EMPTY_TAG_FILTER);
    expect(window.localStorage.length).toBe(0);
    expect(loadTagFilter("p1")).toEqual(EMPTY_TAG_FILTER);
  });

  it("degrades garbage to the empty filter and re-enforces exclusivity", () => {
    window.localStorage.setItem("hitch:v2:todo-tag-filter:p1", "not json");
    expect(loadTagFilter("p1")).toEqual(EMPTY_TAG_FILTER);
    window.localStorage.setItem(
      "hitch:v2:todo-tag-filter:p2",
      JSON.stringify({ tags: ["bug"], untagged: true }),
    );
    expect(loadTagFilter("p2")).toEqual({ tags: [], untagged: true });
  });

  it("never loads another project's filter", () => {
    saveTagFilter("p1", { tags: ["bug"], untagged: false });
    expect(loadTagFilter("p3")).toEqual(EMPTY_TAG_FILTER);
  });
});
