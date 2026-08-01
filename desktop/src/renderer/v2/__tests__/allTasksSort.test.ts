import { describe, expect, it } from "vitest";

import {
  byProjectThenOrder,
  deriveAllTasks,
  type ProjectTask,
} from "../allTasksSort";

type Row = ProjectTask & { title: string };

function task(over: Partial<Row> & { id: string }): Row {
  return {
    title: over.id,
    status: "open",
    sortOrder: "a0",
    completedAt: null,
    projectId: "p1",
    ...over,
  };
}

const names = (...pairs: [string, string][]) => new Map(pairs);

const ids = (rows: readonly Row[]) => rows.map((t) => t.id);

describe("deriveAllTasks", () => {
  it("clusters rows by project name, A→Z, regardless of arrival order", () => {
    // The whole point of the ordering: with no headers, same-project rows have
    // to end up adjacent or the list reads as shuffled.
    const grouped = deriveAllTasks(
      [
        task({ id: "z1", projectId: "pz", sortOrder: "a1" }),
        task({ id: "a1", projectId: "pa", sortOrder: "a1" }),
        task({ id: "z2", projectId: "pz", sortOrder: "a2" }),
        task({ id: "m1", projectId: "pm", sortOrder: "a1" }),
        task({ id: "a2", projectId: "pa", sortOrder: "a2" }),
      ],
      names(["pa", "Apples"], ["pm", "Mangos"], ["pz", "Zucchini"]),
    );
    expect(ids(grouped.open)).toEqual(["a1", "a2", "m1", "z1", "z2"]);
  });

  it("sorts by project NAME, not by project id", () => {
    // The ids deliberately sort the opposite way from the names.
    const grouped = deriveAllTasks(
      [
        task({ id: "in-aaa", projectId: "aaa" }),
        task({ id: "in-zzz", projectId: "zzz" }),
      ],
      names(["aaa", "Zebra"], ["zzz", "Aardvark"]),
    );
    expect(ids(grouped.open)).toEqual(["in-zzz", "in-aaa"]);
  });

  it("compares names as human words, so case does not band the list", () => {
    // A byte compare would put every capitalised project above every lowercase
    // one ("Zebra" < "apples"); localeCompare reads them as words.
    const grouped = deriveAllTasks(
      [
        task({ id: "upper", projectId: "p-upper" }),
        task({ id: "lower", projectId: "p-lower" }),
      ],
      names(["p-upper", "Zebra"], ["p-lower", "apples"]),
    );
    expect(ids(grouped.open)).toEqual(["lower", "upper"]);
  });

  it("keeps a project's manual order inside its run", () => {
    const grouped = deriveAllTasks(
      [
        task({ id: "third", projectId: "p", sortOrder: "a3" }),
        task({ id: "first", projectId: "p", sortOrder: "a1" }),
        task({ id: "second", projectId: "p", sortOrder: "a2" }),
      ],
      names(["p", "Project"]),
    );
    expect(ids(grouped.open)).toEqual(["first", "second", "third"]);
  });

  it("breaks equal sortOrder inside a project by id, like the project view", () => {
    const grouped = deriveAllTasks(
      [
        task({ id: "b", projectId: "p", sortOrder: "a1" }),
        task({ id: "a", projectId: "p", sortOrder: "a1" }),
      ],
      names(["p", "Project"]),
    );
    expect(ids(grouped.open)).toEqual(["a", "b"]);
  });

  it("splits done out and orders it by completion across ALL projects", () => {
    // A receipt reads chronologically: the newest completion is top of the list
    // even though its project name sorts last.
    const grouped = deriveAllTasks(
      [
        task({
          id: "old-apples",
          projectId: "pa",
          status: "done",
          completedAt: "2026-07-01T00:00:00.000Z",
        }),
        task({
          id: "new-zucchini",
          projectId: "pz",
          status: "done",
          completedAt: "2026-07-20T00:00:00.000Z",
        }),
        task({
          id: "mid-mangos",
          projectId: "pm",
          status: "done",
          completedAt: "2026-07-10T00:00:00.000Z",
        }),
        task({ id: "still-open", projectId: "pz" }),
      ],
      names(["pa", "Apples"], ["pm", "Mangos"], ["pz", "Zucchini"]),
    );
    expect(ids(grouped.done)).toEqual(["new-zucchini", "mid-mangos", "old-apples"]);
    expect(ids(grouped.open)).toEqual(["still-open"]);
  });

  it("sinks a done row with no parseable completedAt to the bottom", () => {
    const grouped = deriveAllTasks(
      [
        task({ id: "unknown-when", status: "done", completedAt: null }),
        task({ id: "known-when", status: "done", completedAt: "2026-07-01T00:00:00.000Z" }),
      ],
      names(["p1", "Project"]),
    );
    expect(ids(grouped.done)).toEqual(["known-when", "unknown-when"]);
  });

  it("returns two empty lists for empty input", () => {
    expect(deriveAllTasks([], names())).toEqual({ open: [], done: [] });
  });

  it("keeps a task whose project id resolves to no name, at the bottom", () => {
    // The window where the tasks query has landed and the projects query has
    // not: the row must neither crash the fold nor disappear, but it has no
    // name to cluster by, so it does not claim the top of the list.
    const grouped = deriveAllTasks(
      [
        task({ id: "orphan", projectId: "gone" }),
        task({ id: "known", projectId: "p", sortOrder: "z9" }),
      ],
      names(["p", "Zzz Last Project"]),
    );
    expect(ids(grouped.open)).toEqual(["known", "orphan"]);
  });

  it("orders several unknown-project rows deterministically among themselves", () => {
    const grouped = deriveAllTasks(
      [
        task({ id: "b1", projectId: "gone-b", sortOrder: "a2" }),
        task({ id: "a2", projectId: "gone-a", sortOrder: "a2" }),
        task({ id: "a1", projectId: "gone-a", sortOrder: "a1" }),
      ],
      names(),
    );
    expect(ids(grouped.open)).toEqual(["a1", "a2", "b1"]);
  });

  it("keeps two same-named projects as two runs, not one interleaved run", () => {
    // Two projects can genuinely share a name. Falling straight through to
    // sortOrder on an equal name would shuffle their manual orders together.
    const grouped = deriveAllTasks(
      [
        task({ id: "beta-1", projectId: "p-beta", sortOrder: "a1" }),
        task({ id: "alpha-2", projectId: "p-alpha", sortOrder: "a2" }),
        task({ id: "beta-2", projectId: "p-beta", sortOrder: "a2" }),
        task({ id: "alpha-1", projectId: "p-alpha", sortOrder: "a1" }),
      ],
      names(["p-alpha", "Website"], ["p-beta", "Website"]),
    );
    expect(ids(grouped.open)).toEqual(["alpha-1", "alpha-2", "beta-1", "beta-2"]);
  });

  it("is a total order: shuffled inputs fold to the same list", () => {
    const rows = [
      task({ id: "a1", projectId: "pa", sortOrder: "a1" }),
      task({ id: "a2", projectId: "pa", sortOrder: "a1" }),
      task({ id: "b1", projectId: "pb", sortOrder: "a1" }),
      task({ id: "orphan", projectId: "gone" }),
      task({ id: "dup", projectId: "pdup", sortOrder: "a1" }),
    ];
    const map = names(["pa", "Same"], ["pdup", "Same"], ["pb", "Other"]);
    const expected = ids(deriveAllTasks(rows, map).open);
    expect(ids(deriveAllTasks([...rows].reverse(), map).open)).toEqual(expected);
    expect(ids(deriveAllTasks([rows[2], rows[4], rows[0], rows[3], rows[1]], map).open)).toEqual(
      expected,
    );
  });

  it("does not mutate its input", () => {
    const rows = [
      task({ id: "z", projectId: "pz", sortOrder: "a2" }),
      task({ id: "a", projectId: "pa", sortOrder: "a1" }),
      task({ id: "d", status: "done", completedAt: "2026-07-01T00:00:00.000Z" }),
    ];
    deriveAllTasks(rows, names(["pa", "Apples"], ["pz", "Zucchini"]));
    expect(ids(rows)).toEqual(["z", "a", "d"]);
  });
});

describe("byProjectThenOrder", () => {
  it("is antisymmetric across the known/unknown boundary", () => {
    const compare = byProjectThenOrder(names(["p", "Project"]));
    const known = task({ id: "known", projectId: "p" });
    const unknown = task({ id: "unknown", projectId: "gone" });
    expect(compare(known, unknown)).toBeLessThan(0);
    expect(compare(unknown, known)).toBeGreaterThan(0);
  });

  it("reports 0 only for the identical row", () => {
    const compare = byProjectThenOrder(names(["p", "Project"]));
    const row = task({ id: "x", projectId: "p" });
    expect(compare(row, row)).toBe(0);
    expect(compare(row, task({ id: "y", projectId: "p" }))).not.toBe(0);
  });
});
