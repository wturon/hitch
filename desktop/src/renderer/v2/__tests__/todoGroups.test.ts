import { describe, expect, it } from "vitest";

import {
  chatsByTaskId,
  chatsForTask,
  deriveTaskGroups,
  partitionLaneChats,
  rowState,
  type AttentionAssignment,
  type HarnessChipState,
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

// The observed_state → chip mapping is no longer exported on its own — a chat
// carries its already-mapped state, so a one-assignment lane is how you read the
// mapping. `null` means the chat was dropped (nothing to open).
function stateOf(
  overrides: Partial<AttentionAssignment> & Pick<AttentionAssignment, "observedState">,
): HarnessChipState | null {
  const a = assignment({ taskId: "solo", ...overrides });
  return chatsForTask([a], "solo")[0]?.state ?? null;
}

describe("chatsForTask (the observed_state → chip mapping)", () => {
  it("maps every in-flight state to one working chip", () => {
    // The row used to distinguish "Spawning…" from "Working"; the chip
    // deliberately does not — at 22px they are the same fact.
    for (const observedState of ["pending", "spawning", "running"] as const) {
      expect(stateOf({ observedState })).toBe("working");
    }
  });

  it("maps waiting_input → needs-you", () => {
    expect(stateOf({ observedState: "waiting_input" })).toBe("needs-you");
  });

  it("treats a finished-but-unreviewed agent as needing you", () => {
    // The state V1's chip never had: it was the row's "Mark reviewed" button.
    expect(stateOf({ observedState: "done", reviewedAt: null })).toBe("needs-you");
  });

  it("falls back to idle once reviewed — the chat is still openable", () => {
    expect(stateOf({ observedState: "done", reviewedAt: "2026-07-26T00:00:00Z" })).toBe(
      "idle",
    );
  });

  it("DROPS a dead launch — it never produced a chat, so there is nothing to open", () => {
    const dead = assignment({ taskId: "t", observedState: "dead" });
    expect(chatsForTask([dead], "t")).toEqual([]);
  });

  it("returns an empty lane for no assignments at all", () => {
    expect(chatsForTask(undefined, "t")).toEqual([]);
    expect(chatsForTask([], "t")).toEqual([]);
  });

  it("takes only the requested task's assignments", () => {
    const mine = assignment({ taskId: "mine", observedState: "running" });
    const theirs = assignment({ taskId: "theirs", observedState: "running" });
    expect(chatsForTask([mine, theirs], "mine").map((c) => c.assignment.id)).toEqual([
      mine.id,
    ]);
  });

  it("bands by demand — needs-you, then working, then idle — regardless of recency", () => {
    // The newest chat here is the IDLE one; band order must still put the one
    // that wants a human first, because the row's chip speaks for the head.
    const t = "task-multi";
    const idle = assignment({
      taskId: t,
      observedState: "done",
      reviewedAt: "2026-07-26T00:00:00.000Z",
      createdAt: "2026-07-22T15:00:00.000Z",
    });
    const working = assignment({
      taskId: t,
      observedState: "running",
      createdAt: "2026-07-22T14:00:00.000Z",
    });
    const blocked = assignment({
      taskId: t,
      observedState: "waiting_input",
      createdAt: "2026-07-22T09:00:00.000Z",
    });
    expect(chatsForTask([idle, working, blocked], t).map((c) => c.state)).toEqual([
      "needs-you",
      "working",
      "idle",
    ]);
  });

  it("orders newest-first INSIDE a band", () => {
    const t = "task-band";
    const older = assignment({
      taskId: t,
      observedState: "running",
      createdAt: "2026-07-22T09:00:00.000Z",
    });
    const newer = assignment({
      taskId: t,
      observedState: "running",
      createdAt: "2026-07-22T12:00:00.000Z",
    });
    expect(chatsForTask([older, newer], t).map((c) => c.assignment.id)).toEqual([
      newer.id,
      older.id,
    ]);
    // Input order must not matter — the comparator is the only ordering.
    expect(chatsForTask([newer, older], t).map((c) => c.assignment.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("parses createdAt as an epoch rather than sorting ISO strings", () => {
    // Same instant, two legal spellings plus a Date (the optimistic-cache
    // shape): a lexicographic sort would order these arbitrarily.
    const t = "task-epoch";
    const older = assignment({
      taskId: t,
      observedState: "running",
      createdAt: new Date("2026-07-22T09:00:00.000Z"),
    });
    const newer = assignment({
      taskId: t,
      observedState: "running",
      // No millis and a "+00:00" offset — still the later instant.
      createdAt: "2026-07-22T11:30:00+00:00",
    });
    expect(chatsForTask([older, newer], t).map((c) => c.assignment.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("breaks exact createdAt ties by id DESC for a total order", () => {
    // uuidv7 ids are creation-ordered, so id DESC continues "newest first" —
    // and it never jumps between refetches of identical data.
    const t = "task-tie";
    const at = "2026-07-22T10:00:00.000Z";
    const a = assignment({ taskId: t, observedState: "running", createdAt: at, id: "a" });
    const b = assignment({ taskId: t, observedState: "running", createdAt: at, id: "b" });
    expect(chatsForTask([a, b], t).map((c) => c.assignment.id)).toEqual(["b", "a"]);
    expect(chatsForTask([b, a], t).map((c) => c.assignment.id)).toEqual(["b", "a"]);
  });
});

describe("chatsByTaskId", () => {
  it("folds every task in one pass, with chatsForTask's exact ordering", () => {
    const one = assignment({
      taskId: "t1",
      observedState: "running",
      createdAt: "2026-07-22T09:00:00.000Z",
    });
    const two = assignment({
      taskId: "t1",
      observedState: "waiting_input",
      createdAt: "2026-07-22T08:00:00.000Z",
    });
    const other = assignment({ taskId: "t2", observedState: "running" });
    const map = chatsByTaskId([one, two, other]);
    expect(map.get("t1")).toEqual(chatsForTask([one, two, other], "t1"));
    expect(map.get("t1")?.map((c) => c.state)).toEqual(["needs-you", "working"]);
    expect(map.get("t2")).toHaveLength(1);
  });

  it("gives a task with only dead assignments NO entry (so get() is absent = no chip)", () => {
    const map = chatsByTaskId([
      assignment({ taskId: "gone", observedState: "dead" }),
      assignment({ taskId: "gone", observedState: "dead" }),
    ]);
    expect(map.has("gone")).toBe(false);
  });

  it("returns an empty map for no assignments", () => {
    expect(chatsByTaskId(undefined).size).toBe(0);
    expect(chatsByTaskId([]).size).toBe(0);
  });
});

describe("rowState", () => {
  it("reduces by severity, not recency: working + needs-you → needs-you", () => {
    // The bug this exists to kill — a row saying "Working" while a second agent
    // on the same task sits blocked on the user.
    const t = "task-mixed";
    const chats = chatsForTask(
      [
        assignment({
          taskId: t,
          observedState: "running",
          createdAt: "2026-07-22T14:00:00.000Z",
        }),
        assignment({
          taskId: t,
          observedState: "waiting_input",
          createdAt: "2026-07-22T09:00:00.000Z",
        }),
      ],
      t,
    );
    expect(rowState(chats)).toBe("needs-you");
  });

  it("prefers working over idle", () => {
    const t = "task-idle-plus";
    const chats = chatsForTask(
      [
        assignment({
          taskId: t,
          observedState: "done",
          reviewedAt: "2026-07-26T00:00:00.000Z",
          createdAt: "2026-07-22T15:00:00.000Z",
        }),
        assignment({
          taskId: t,
          observedState: "pending",
          createdAt: "2026-07-22T08:00:00.000Z",
        }),
      ],
      t,
    );
    expect(rowState(chats)).toBe("working");
  });

  it("reports idle when every chat is finished and acked", () => {
    const t = "task-quiet";
    const chats = chatsForTask(
      [
        assignment({
          taskId: t,
          observedState: "done",
          reviewedAt: "2026-07-26T00:00:00.000Z",
        }),
      ],
      t,
    );
    expect(rowState(chats)).toBe("idle");
  });

  it("shows nothing when the task has no chats (never delegated, or all dead)", () => {
    expect(rowState(undefined)).toBeNull();
    expect(rowState([])).toBeNull();
    const allDead = chatsForTask([assignment({ taskId: "t", observedState: "dead" })], "t");
    expect(rowState(allDead)).toBeNull();
  });
});

describe("partitionLaneChats", () => {
  it("splits still-in-play chats from acked history, preserving order", () => {
    const t = "task-lane";
    const chats = chatsForTask(
      [
        assignment({
          taskId: t,
          observedState: "waiting_input",
          createdAt: "2026-07-22T09:00:00.000Z",
          id: "blocked",
        }),
        assignment({
          taskId: t,
          observedState: "running",
          createdAt: "2026-07-22T10:00:00.000Z",
          id: "live",
        }),
        assignment({
          taskId: t,
          observedState: "done",
          reviewedAt: "2026-07-26T00:00:00.000Z",
          createdAt: "2026-07-22T12:00:00.000Z",
          id: "old-new",
        }),
        assignment({
          taskId: t,
          observedState: "done",
          reviewedAt: "2026-07-26T00:00:00.000Z",
          createdAt: "2026-07-22T11:00:00.000Z",
          id: "old-old",
        }),
      ],
      t,
    );
    const { visible, earlier } = partitionLaneChats(chats);
    expect(visible.map((c) => c.assignment.id)).toEqual(["blocked", "live"]);
    expect(earlier.map((c) => c.assignment.id)).toEqual(["old-new", "old-old"]);
  });

  it("returns two empty sides for an empty lane", () => {
    expect(partitionLaneChats([])).toEqual({ visible: [], earlier: [] });
  });
});

describe("deriveTaskGroups with attention", () => {
  it("buckets open tasks by their chats' attention", () => {
    const inputTask = task({ sortOrder: "a0", title: "needs-input" });
    const reviewTask = task({ sortOrder: "a1", title: "needs-review" });
    const workingTask = task({ sortOrder: "a2", title: "working" });
    const plainTask = task({ sortOrder: "a3", title: "plain-backlog" });
    const chats = chatsByTaskId([
      assignment({ taskId: inputTask.id, observedState: "waiting_input" }),
      assignment({ taskId: reviewTask.id, observedState: "done", reviewedAt: null }),
      assignment({ taskId: workingTask.id, observedState: "running" }),
      // plainTask's only assignment is dead → it has NO chats → backlog.
      assignment({ taskId: plainTask.id, observedState: "dead" }),
    ]);
    const groups = deriveTaskGroups(
      [inputTask, reviewTask, workingTask, plainTask],
      chats,
    );
    expect(groups.needsYou.map((t) => t.title)).toEqual(["needs-input", "needs-review"]);
    expect(groups.working.map((t) => t.title)).toEqual(["working"]);
    expect(groups.backlog.map((t) => t.title)).toEqual(["plain-backlog"]);
  });

  it("lets ANY chat pull a task into NEEDS YOU while another one works", () => {
    // The newest chat is the running one — the old latest-wins fold filed this
    // task under WORKING and the blocked agent was never surfaced.
    const t = task({ sortOrder: "a0", title: "two-agents" });
    const groups = deriveTaskGroups(
      [t],
      chatsByTaskId([
        assignment({
          taskId: t.id,
          observedState: "waiting_input",
          createdAt: "2026-07-22T09:00:00.000Z",
        }),
        assignment({
          taskId: t.id,
          observedState: "running",
          createdAt: "2026-07-22T14:00:00.000Z",
        }),
      ]),
    );
    expect(groups.needsYou.map((x) => x.title)).toEqual(["two-agents"]);
    expect(groups.working).toHaveLength(0);
    expect(groups.backlog).toHaveLength(0);
  });

  it("puts every in-flight state (pending/spawning/running) in WORKING", () => {
    for (const observedState of ["pending", "spawning", "running"] as const) {
      const t = task({ sortOrder: "a0", title: observedState });
      const groups = deriveTaskGroups(
        [t],
        chatsByTaskId([assignment({ taskId: t.id, observedState })]),
      );
      expect(groups.working.map((x) => x.title)).toEqual([observedState]);
      expect(groups.backlog).toHaveLength(0);
    }
  });

  it("collapses BOTH kinds of needs-you chat into NEEDS YOU", () => {
    // `waiting_input` and finished-unreviewed are one group here — the fold has
    // no input-beats-review precedence to express, because NEEDS YOU is NEEDS
    // YOU. The second task pairs a finished-unreviewed chat with a running one:
    // needs-you still outranks working.
    const bothKinds = task({ sortOrder: "a0", title: "blocked-and-finished" });
    const finishedWhileWorking = task({ sortOrder: "a1", title: "finished-plus-working" });
    const groups = deriveTaskGroups(
      [bothKinds, finishedWhileWorking],
      chatsByTaskId([
        assignment({ taskId: bothKinds.id, observedState: "done", reviewedAt: null }),
        assignment({ taskId: bothKinds.id, observedState: "waiting_input" }),
        assignment({ taskId: finishedWhileWorking.id, observedState: "running" }),
        assignment({
          taskId: finishedWhileWorking.id,
          observedState: "done",
          reviewedAt: null,
        }),
      ]),
    );
    expect(groups.needsYou.map((x) => x.title)).toEqual([
      "blocked-and-finished",
      "finished-plus-working",
    ]);
    expect(groups.working).toHaveLength(0);
    expect(groups.backlog).toHaveLength(0);
  });

  it("files a task whose only chats are acked-done or dead in BACKLOG", () => {
    const t = task({ sortOrder: "a0", title: "quiet" });
    const groups = deriveTaskGroups(
      [t],
      chatsByTaskId([
        assignment({
          taskId: t.id,
          observedState: "done",
          reviewedAt: "2026-07-22T11:00:00.000Z",
        }),
        assignment({ taskId: t.id, observedState: "dead" }),
      ]),
    );
    expect(groups.backlog.map((x) => x.title)).toEqual(["quiet"]);
    expect(groups.needsYou).toHaveLength(0);
    expect(groups.working).toHaveLength(0);
  });

  it("ignores acked-done and dead chats next to a live one", () => {
    const t = task({ sortOrder: "a0", title: "one-live" });
    const groups = deriveTaskGroups(
      [t],
      chatsByTaskId([
        assignment({
          taskId: t.id,
          observedState: "done",
          reviewedAt: "2026-07-22T11:00:00.000Z",
        }),
        assignment({ taskId: t.id, observedState: "dead" }),
        assignment({ taskId: t.id, observedState: "running" }),
      ]),
    );
    expect(groups.working.map((x) => x.title)).toEqual(["one-live"]);
    expect(groups.needsYou).toHaveLength(0);
    expect(groups.backlog).toHaveLength(0);
  });

  it("removes attention tasks from backlog (no double-count)", () => {
    const t = task({ sortOrder: "a0", title: "busy" });
    const chats = chatsByTaskId([assignment({ taskId: t.id, observedState: "running" })]);
    const groups = deriveTaskGroups([t], chats);
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
    const chats = chatsByTaskId([
      assignment({ taskId: t.id, observedState: "done", reviewedAt: null }),
    ]);
    const groups = deriveTaskGroups([t], chats);
    expect(groups.done.map((x) => x.title)).toEqual(["finished"]);
    expect(groups.needsYou).toHaveLength(0);
  });

  it("drops a task out of NEEDS YOU once its done assignment is acked", () => {
    const t = task({ sortOrder: "a0", title: "acked" });
    const unacked = deriveTaskGroups(
      [t],
      chatsByTaskId([assignment({ taskId: t.id, observedState: "done" })]),
    );
    expect(unacked.needsYou.map((x) => x.title)).toEqual(["acked"]);
    const acked = deriveTaskGroups(
      [t],
      chatsByTaskId([
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
