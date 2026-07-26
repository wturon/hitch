import { describe, expect, it } from "vitest";

import {
  deriveSectionedTasks,
  sortSections,
  tasksInContainer,
  type PlacedTask,
  type SectionRow,
} from "../sectionGroups";
import { filterSectionedTasks } from "../tagFilter";

type Row = PlacedTask & { title: string };

function task(over: Partial<Row> & { id: string }): Row {
  return {
    title: over.id,
    status: "open",
    sortOrder: "a0",
    completedAt: null,
    sectionId: null,
    ...over,
  };
}

const section = (id: string, sortOrder: string, name = id): SectionRow => ({
  id,
  name,
  sortOrder,
});

describe("deriveSectionedTasks", () => {
  it("puts task with no section in loose, in sortOrder order", () => {
    const grouped = deriveSectionedTasks(
      [
        task({ id: "b", sortOrder: "a2" }),
        task({ id: "a", sortOrder: "a1" }),
        task({ id: "c", sortOrder: "a3" }),
      ],
      [],
    );
    expect(grouped.loose.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(grouped.sections).toEqual([]);
  });

  it("files tasks into their section and orders sections by sortOrder", () => {
    const grouped = deriveSectionedTasks(
      [
        task({ id: "in-2", sectionId: "s2" }),
        task({ id: "in-1", sectionId: "s1" }),
        task({ id: "loose" }),
      ],
      [section("s2", "a2"), section("s1", "a1")],
    );
    expect(grouped.loose.map((t) => t.id)).toEqual(["loose"]);
    expect(grouped.sections.map((b) => b.section.id)).toEqual(["s1", "s2"]);
    expect(grouped.sections[0].tasks.map((t) => t.id)).toEqual(["in-1"]);
    expect(grouped.sections[1].tasks.map((t) => t.id)).toEqual(["in-2"]);
  });

  it("keeps empty sections — they are structure, not a projection", () => {
    const grouped = deriveSectionedTasks([], [section("s1", "a1")]);
    expect(grouped.sections).toHaveLength(1);
    expect(grouped.sections[0].tasks).toEqual([]);
  });

  it("breaks equal sortOrder ties by id, for sections and tasks alike", () => {
    const grouped = deriveSectionedTasks(
      [
        task({ id: "b", sortOrder: "a1" }),
        task({ id: "a", sortOrder: "a1" }),
      ],
      [section("s2", "a1"), section("s1", "a1")],
    );
    expect(grouped.loose.map((t) => t.id)).toEqual(["a", "b"]);
    expect(grouped.sections.map((b) => b.section.id)).toEqual(["s1", "s2"]);
  });

  it("renders an orphan as loose rather than dropping it", () => {
    // The window after DELETE /sections nulls section_id server-side but before
    // the tasks query has refetched: the task still names a section that is
    // already gone from the sections query.
    const grouped = deriveSectionedTasks(
      [task({ id: "orphan", sectionId: "deleted-section" })],
      [section("s1", "a1")],
    );
    expect(grouped.loose.map((t) => t.id)).toEqual(["orphan"]);
    expect(grouped.sections[0].tasks).toEqual([]);
  });

  it("pulls done out of every container into one list, newest first", () => {
    const grouped = deriveSectionedTasks(
      [
        task({
          id: "old",
          status: "done",
          completedAt: "2026-07-01T00:00:00.000Z",
          sectionId: "s1",
        }),
        task({
          id: "new",
          status: "done",
          completedAt: "2026-07-20T00:00:00.000Z",
        }),
        task({ id: "open", sectionId: "s1" }),
      ],
      [section("s1", "a1")],
    );
    expect(grouped.done.map((t) => t.id)).toEqual(["new", "old"]);
    expect(grouped.sections[0].tasks.map((t) => t.id)).toEqual(["open"]);
    expect(grouped.loose).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const tasks = [task({ id: "b", sortOrder: "a2" }), task({ id: "a", sortOrder: "a1" })];
    const sections = [section("s2", "a2"), section("s1", "a1")];
    deriveSectionedTasks(tasks, sections);
    expect(tasks.map((t) => t.id)).toEqual(["b", "a"]);
    expect(sections.map((s) => s.id)).toEqual(["s2", "s1"]);
  });
});

describe("tasksInContainer", () => {
  const sections = [section("s1", "a1")];
  const rows = [
    task({ id: "loose-2", sortOrder: "a2" }),
    task({ id: "loose-1", sortOrder: "a1" }),
    task({ id: "filed", sortOrder: "a0", sectionId: "s1" }),
    task({ id: "finished", sortOrder: "a0", status: "done", completedAt: null }),
  ];

  it("returns only the loose OPEN tasks for the null container", () => {
    expect(tasksInContainer(rows, sections, null).map((t) => t.id)).toEqual([
      "loose-1",
      "loose-2",
    ]);
  });

  it("returns a section's own open tasks", () => {
    expect(tasksInContainer(rows, sections, "s1").map((t) => t.id)).toEqual(["filed"]);
  });

  it("counts an orphan as loose, so a prepend lands above it", () => {
    // Filtering on sectionId directly would miss this and put a fresh capture
    // BELOW a row it renders above.
    const orphan = task({ id: "orphan", sortOrder: "a0", sectionId: "gone" });
    expect(tasksInContainer([...rows, orphan], sections, null)[0].id).toBe("orphan");
  });

  it("returns empty for a section that does not exist", () => {
    expect(tasksInContainer(rows, sections, "nope")).toEqual([]);
  });
});

describe("filterSectionedTasks", () => {
  const grouped = deriveSectionedTasks(
    [
      task({ id: "loose-hit" }),
      task({ id: "loose-miss" }),
      task({ id: "s1-hit", sectionId: "s1" }),
      task({ id: "s2-miss", sectionId: "s2" }),
      task({ id: "done-hit", status: "done", completedAt: null }),
    ],
    [section("s1", "a1"), section("s2", "a2")],
  );
  const namesOf = (t: Row) => (t.id.endsWith("hit") ? ["keep"] : []);

  it("returns the same object when the filter is inactive", () => {
    expect(filterSectionedTasks(grouped, { tags: [], untagged: false }, namesOf)).toBe(
      grouped,
    );
  });

  it("drops non-matching rows but KEEPS every section", () => {
    // A section the filter empties still has to exist as a bucket: if it is
    // collapsed and holding a live agent, its header is the only place that
    // agent can appear. Whether to render it is the view's call, not this
    // function's.
    const filtered = filterSectionedTasks(
      grouped,
      { tags: ["keep"], untagged: false },
      namesOf,
    );
    expect(filtered.loose.map((t) => t.id)).toEqual(["loose-hit"]);
    expect(filtered.sections.map((b) => b.section.id)).toEqual(["s1", "s2"]);
    expect(filtered.sections[0].tasks.map((t) => t.id)).toEqual(["s1-hit"]);
    expect(filtered.sections[1].tasks).toEqual([]);
    expect(filtered.done.map((t) => t.id)).toEqual(["done-hit"]);
  });
});

describe("sortSections", () => {
  it("orders by sortOrder regardless of the array it arrived in", () => {
    // GET /sections orders on a `text` column under the database's collation,
    // and an optimistic reorder rewrites sortOrder WITHOUT moving the row — so
    // the array the client holds is not reliably in list order.
    const rows = [section("c", "a3"), section("a", "a1"), section("b", "a2")];
    expect(sortSections(rows).map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const rows = [section("b", "a2"), section("a", "a1")];
    sortSections(rows);
    expect(rows.map((s) => s.id)).toEqual(["b", "a"]);
  });
});
