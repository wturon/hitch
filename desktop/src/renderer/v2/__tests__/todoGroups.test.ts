import { describe, expect, it } from "vitest";

import { deriveTaskGroups, type TaskRow } from "../todoGroups";

// Rows carry an extra field to prove the generic fold returns the caller's
// full type, not a stripped TaskRow.
interface FixtureRow extends TaskRow {
  title: string;
}

let seq = 0;
function task(overrides: Partial<FixtureRow> & Pick<FixtureRow, "sortOrder">): FixtureRow {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    title: `task-${seq}`,
    status: "open",
    completedAt: null,
    ...overrides,
  };
}

describe("deriveTaskGroups", () => {
  it("keeps the four-group scaffolding with NEEDS YOU / WORKING empty", () => {
    const groups = deriveTaskGroups([
      task({ sortOrder: "a0" }),
      task({ sortOrder: "a1", status: "done", completedAt: "2026-07-20T10:00:00.000Z" }),
    ]);
    expect(groups.needsYou).toEqual([]);
    expect(groups.working).toEqual([]);
    expect(Object.keys(groups).sort()).toEqual(["backlog", "done", "needsYou", "working"]);
  });

  it("orders open tasks by sortOrder string compare, not input order", () => {
    const groups = deriveTaskGroups([
      task({ sortOrder: "a2", title: "third" }),
      task({ sortOrder: "a0", title: "first" }),
      task({ sortOrder: "a1", title: "second" }),
    ]);
    expect(groups.backlog.map((t) => t.title)).toEqual(["first", "second", "third"]);
    expect(groups.done).toEqual([]);
  });

  it("compares sortOrder as raw strings (fractional-index semantics)", () => {
    // "a0V" sits between "a0" and "a1" — the classic midpoint key.
    const groups = deriveTaskGroups([
      task({ sortOrder: "a1", title: "last" }),
      task({ sortOrder: "a0V", title: "middle" }),
      task({ sortOrder: "a0", title: "head" }),
      // A shorter key that is a prefix of a longer one sorts first.
      task({ sortOrder: "Zz", title: "before-a" }),
    ]);
    expect(groups.backlog.map((t) => t.title)).toEqual([
      "before-a",
      "head",
      "middle",
      "last",
    ]);
  });

  it("breaks sortOrder ties by id for a stable total order", () => {
    const a = task({ sortOrder: "a0", id: "00000000-0000-7000-8000-00000000000b" });
    const b = task({ sortOrder: "a0", id: "00000000-0000-7000-8000-00000000000a" });
    expect(deriveTaskGroups([a, b]).backlog.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(deriveTaskGroups([b, a]).backlog.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("groups done tasks by completedAt desc regardless of sortOrder", () => {
    const groups = deriveTaskGroups([
      task({
        sortOrder: "a0",
        title: "older",
        status: "done",
        completedAt: "2026-07-19T08:00:00.000Z",
      }),
      task({
        sortOrder: "a2",
        title: "newest",
        status: "done",
        completedAt: "2026-07-21T09:30:00.000Z",
      }),
      task({
        sortOrder: "a1",
        title: "middle",
        status: "done",
        completedAt: "2026-07-20T12:00:00.000Z",
      }),
      task({ sortOrder: "a3", title: "still-open" }),
    ]);
    expect(groups.done.map((t) => t.title)).toEqual(["newest", "middle", "older"]);
    expect(groups.backlog.map((t) => t.title)).toEqual(["still-open"]);
  });

  it("sinks done rows with a missing or unparseable completedAt to the bottom", () => {
    const groups = deriveTaskGroups([
      task({ sortOrder: "a0", title: "no-stamp", status: "done", completedAt: null }),
      task({
        sortOrder: "a1",
        title: "stamped",
        status: "done",
        completedAt: "2026-07-20T12:00:00.000Z",
      }),
      task({ sortOrder: "a2", title: "garbled", status: "done", completedAt: "not-a-date" }),
    ]);
    expect(groups.done.map((t) => t.title).slice(0, 1)).toEqual(["stamped"]);
    expect(new Set(groups.done.map((t) => t.title).slice(1))).toEqual(
      new Set(["no-stamp", "garbled"]),
    );
  });

  it("returns empty groups for an empty project", () => {
    expect(deriveTaskGroups([])).toEqual({
      needsYou: [],
      working: [],
      backlog: [],
      done: [],
    });
  });

  it("preserves the caller's row type through the fold", () => {
    const groups = deriveTaskGroups([task({ sortOrder: "a0", title: "typed" })]);
    // Compile-time: `title` is accessible without a cast. Runtime: it survives.
    expect(groups.backlog[0].title).toBe("typed");
  });
});
