import { describe, expect, it } from "vitest";

import {
  deriveTaskGroups,
  latestAssignmentByTaskId,
  taskAttention,
  type AttentionAssignment,
  type TaskRow,
} from "../todoGroups";

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

// ─── Attention queue (M4 PR 6) ───────────────────────────────────────────────

let aseq = 0;
function assignment(
  overrides: Partial<AttentionAssignment> & Pick<AttentionAssignment, "taskId" | "observedState">,
): AttentionAssignment {
  aseq += 1;
  return {
    id: `assignment-${aseq}`,
    createdAt: `2026-07-22T10:00:${String(aseq % 60).padStart(2, "0")}.000Z`,
    reviewedAt: null,
    ...overrides,
  };
}

describe("taskAttention", () => {
  it("maps waiting_input → input", () => {
    expect(taskAttention({ observedState: "waiting_input", reviewedAt: null })).toBe("input");
  });

  it("maps in-flight states (pending/spawning/running) → working", () => {
    for (const observedState of ["pending", "spawning", "running"] as const) {
      expect(taskAttention({ observedState, reviewedAt: null })).toBe("working");
    }
  });

  it("maps done → review only while unreviewed; acked done → null", () => {
    expect(taskAttention({ observedState: "done", reviewedAt: null })).toBe("review");
    expect(
      taskAttention({ observedState: "done", reviewedAt: "2026-07-22T11:00:00.000Z" }),
    ).toBeNull();
  });

  it("maps dead and absent → null (backlog, re-delegate in the dialog)", () => {
    expect(taskAttention({ observedState: "dead", reviewedAt: null })).toBeNull();
    expect(taskAttention(null)).toBeNull();
    expect(taskAttention(undefined)).toBeNull();
  });
});

describe("latestAssignmentByTaskId", () => {
  it("keeps the most-recently-created assignment per task", () => {
    const t = "task-x";
    const older = assignment({
      taskId: t,
      observedState: "dead",
      createdAt: "2026-07-22T09:00:00.000Z",
    });
    const newer = assignment({
      taskId: t,
      observedState: "running",
      createdAt: "2026-07-22T12:00:00.000Z",
    });
    const map = latestAssignmentByTaskId([older, newer]);
    expect(map.get(t)?.id).toBe(newer.id);
  });

  it("returns an empty map for no assignments", () => {
    expect(latestAssignmentByTaskId(undefined).size).toBe(0);
    expect(latestAssignmentByTaskId([]).size).toBe(0);
  });
});

describe("deriveTaskGroups with attention", () => {
  it("buckets open tasks by their latest assignment's attention", () => {
    const inputTask = task({ sortOrder: "a0", title: "needs-input" });
    const reviewTask = task({ sortOrder: "a1", title: "needs-review" });
    const workingTask = task({ sortOrder: "a2", title: "working" });
    const plainTask = task({ sortOrder: "a3", title: "plain-backlog" });
    const latest = latestAssignmentByTaskId([
      assignment({ taskId: inputTask.id, observedState: "waiting_input" }),
      assignment({ taskId: reviewTask.id, observedState: "done", reviewedAt: null }),
      assignment({ taskId: workingTask.id, observedState: "running" }),
      // plainTask's latest is dead → no attention → backlog.
      assignment({ taskId: plainTask.id, observedState: "dead" }),
    ]);
    const groups = deriveTaskGroups(
      [inputTask, reviewTask, workingTask, plainTask],
      latest,
    );
    expect(groups.needsYou.map((t) => t.title)).toEqual(["needs-input", "needs-review"]);
    expect(groups.working.map((t) => t.title)).toEqual(["working"]);
    expect(groups.backlog.map((t) => t.title)).toEqual(["plain-backlog"]);
  });

  it("removes attention tasks from backlog (no double-count)", () => {
    const t = task({ sortOrder: "a0", title: "busy" });
    const latest = latestAssignmentByTaskId([
      assignment({ taskId: t.id, observedState: "running" }),
    ]);
    const groups = deriveTaskGroups([t], latest);
    expect(groups.working).toHaveLength(1);
    expect(groups.backlog).toHaveLength(0);
  });

  it("keeps a DONE task in DONE even with a done-unreviewed assignment (close-on-done)", () => {
    const t = task({
      sortOrder: "a0",
      title: "finished",
      status: "done",
      completedAt: "2026-07-22T12:00:00.000Z",
    });
    const latest = latestAssignmentByTaskId([
      assignment({ taskId: t.id, observedState: "done", reviewedAt: null }),
    ]);
    const groups = deriveTaskGroups([t], latest);
    expect(groups.done.map((x) => x.title)).toEqual(["finished"]);
    expect(groups.needsYou).toHaveLength(0);
  });

  it("drops a task out of NEEDS YOU once its done assignment is acked", () => {
    const t = task({ sortOrder: "a0", title: "acked" });
    const unacked = deriveTaskGroups(
      [t],
      latestAssignmentByTaskId([assignment({ taskId: t.id, observedState: "done" })]),
    );
    expect(unacked.needsYou.map((x) => x.title)).toEqual(["acked"]);
    const acked = deriveTaskGroups(
      [t],
      latestAssignmentByTaskId([
        assignment({
          taskId: t.id,
          observedState: "done",
          reviewedAt: "2026-07-22T13:00:00.000Z",
        }),
      ]),
    );
    expect(acked.needsYou).toHaveLength(0);
    expect(acked.backlog.map((x) => x.title)).toEqual(["acked"]);
  });

  it("leaves the groups empty-of-attention when no map is passed", () => {
    const t = task({ sortOrder: "a0", title: "open" });
    const groups = deriveTaskGroups([t]);
    expect(groups.needsYou).toHaveLength(0);
    expect(groups.working).toHaveLength(0);
    expect(groups.backlog.map((x) => x.title)).toEqual(["open"]);
  });
});
