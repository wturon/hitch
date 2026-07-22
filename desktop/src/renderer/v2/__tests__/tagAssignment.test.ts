// The pure half of the PR 5 tag writes: the optimistic tasks-cache patches
// (the cache projection of POST/DELETE /tasks/:id/tags/:tagId) plus the
// name↔row resolution helpers the UI's names-as-identity model rides on.
import { describe, expect, it } from "vitest";

import {
  buildTagOptions,
  tagNamesFor,
  withTaskTagLinked,
  withTaskTagUnlinked,
} from "../tagAssignment";

const tasks = [
  { id: "t1", tagIds: ["a"], title: "one" },
  { id: "t2", tagIds: [], title: "two" },
];

describe("withTaskTagLinked", () => {
  it("adds the tag id to the one row, preserving link order", () => {
    const next = withTaskTagLinked(tasks, "t1", "b");
    expect(next.find((t) => t.id === "t1")?.tagIds).toEqual(["a", "b"]);
    expect(next.find((t) => t.id === "t2")?.tagIds).toEqual([]);
  });

  it("keeps the untouched rows by reference and never mutates the input", () => {
    const next = withTaskTagLinked(tasks, "t1", "b");
    expect(next[1]).toBe(tasks[1]);
    expect(tasks[0].tagIds).toEqual(["a"]);
  });

  it("is idempotent (matches the server's onConflictDoNothing)", () => {
    const next = withTaskTagLinked(tasks, "t1", "a");
    expect(next[0]).toBe(tasks[0]);
  });

  it("an unknown task id is a no-op", () => {
    expect(withTaskTagLinked(tasks, "ghost", "b")).toEqual(tasks);
  });

  it("carries the row's other fields through the patch", () => {
    const next = withTaskTagLinked(tasks, "t1", "b");
    expect(next[0].title).toBe("one");
  });
});

describe("withTaskTagUnlinked", () => {
  it("removes the tag id from the one row", () => {
    const next = withTaskTagUnlinked(tasks, "t1", "a");
    expect(next.find((t) => t.id === "t1")?.tagIds).toEqual([]);
  });

  it("unlinking an absent tag is a no-op (same row reference)", () => {
    const next = withTaskTagUnlinked(tasks, "t2", "a");
    expect(next[1]).toBe(tasks[1]);
  });

  it("a link → unlink round trip restores the original tag set", () => {
    const linked = withTaskTagLinked(tasks, "t2", "z");
    const unlinked = withTaskTagUnlinked(linked, "t2", "z");
    expect(unlinked.find((t) => t.id === "t2")?.tagIds).toEqual([]);
  });
});

describe("name↔row resolution", () => {
  const rows = [
    { id: "a", name: "bug", color: "blue" },
    { id: "b", name: "urgent", color: "not-a-palette-name" },
  ];

  it("builds name-as-id options, clamping unknown colors to gray", () => {
    expect(buildTagOptions(rows)).toEqual([
      { id: "bug", color: "blue" },
      { id: "urgent", color: "gray" },
    ]);
  });

  it("resolves tagIds to names, dropping ids with no loaded row", () => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(tagNamesFor(["b", "ghost", "a"], byId)).toEqual(["urgent", "bug"]);
  });
});
