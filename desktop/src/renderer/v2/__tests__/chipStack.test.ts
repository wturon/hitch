import { describe, expect, it } from "vitest";

import {
  capChipStack,
  CHIP_STACK_LIMIT,
  COLLAPSED_CHIP_LIMIT,
  liveTaskChips,
  rowChips,
  type ChipAssignment,
  type RowChips,
} from "../chipStack";
import { chatsByTaskId, type AttentionAssignment } from "../todoGroups";

// The row's chip decisions: what a stack draws, what it counts, and which single
// state it reports. Fed through `chatsByTaskId` wherever lane order matters, so
// these pin the behavior the list actually gets rather than a hand-sorted
// approximation of it.

interface Fixture extends ChipAssignment, AttentionAssignment {
  taskId: string;
  createdAt: string;
}

let seq = 0;
function assignment(overrides: Partial<Fixture> = {}): Fixture {
  seq += 1;
  return {
    id: `a${seq}`,
    taskId: "t1",
    harness: "claude",
    chatId: `chat-${seq}`,
    machineId: "m1",
    createdAt: `2026-07-2${seq % 10}T10:00:00.000Z`,
    observedState: "running",
    reviewedAt: null,
    ...overrides,
  };
}

/** The row's chips for one task, joined exactly as TodosView joins them. */
function chipsFor(assignments: Fixture[], taskId = "t1"): RowChips {
  return rowChips(chatsByTaskId(assignments).get(taskId));
}

describe("rowChips", () => {
  it("is the empty slot when a task has no chats at all", () => {
    expect(rowChips(undefined)).toEqual({ chats: [], state: null, ackableId: null });
    expect(chipsFor([])).toEqual({ chats: [], state: null, ackableId: null });
  });

  it("drops dead assignments, so a launch that never produced a chat draws nothing", () => {
    expect(chipsFor([assignment({ observedState: "dead" })])).toEqual({
      chats: [],
      state: null,
      ackableId: null,
    });
  });

  it("carries each chat's harness and open-chat target through", () => {
    const chips = chipsFor([
      assignment({ id: "solo", harness: "codex", chatId: "c9", machineId: "m9" }),
    ]);
    expect(chips.chats).toEqual([
      {
        assignmentId: "solo",
        harness: "codex",
        chatId: "c9",
        machineId: "m9",
        state: "working",
      },
    ]);
    expect(chips.state).toBe("working");
  });

  it("reports the WORST state present, not the newest chat's", () => {
    // The needs-you chat is the OLDER one; picking by recency would report
    // "working" and leave the blocked agent invisible.
    const chips = chipsFor([
      assignment({
        id: "blocked",
        createdAt: "2026-07-20T10:00:00.000Z",
        observedState: "waiting_input",
      }),
      assignment({
        id: "busy",
        createdAt: "2026-07-28T10:00:00.000Z",
        observedState: "running",
      }),
    ]);
    expect(chips.state).toBe("needs-you");
    expect(chips.chats).toHaveLength(2);
  });

  it("reports working over idle", () => {
    const chips = chipsFor([
      assignment({ observedState: "done", reviewedAt: "2026-07-21T10:00:00.000Z" }),
      assignment({ observedState: "spawning" }),
    ]);
    expect(chips.state).toBe("working");
  });

  it("is idle only when every chat is finished and acked", () => {
    const acked = "2026-07-21T10:00:00.000Z";
    const chips = chipsFor([
      assignment({ observedState: "done", reviewedAt: acked }),
      assignment({ observedState: "done", reviewedAt: acked }),
    ]);
    expect(chips.state).toBe("idle");
    expect(chips.chats.map((c) => c.state)).toEqual(["idle", "idle"]);
  });

  // The ring the user sees is the LEADING disc's own ring (it is the one drawn
  // fully in front), so it has to be the same state the row reports. Lane order
  // is what guarantees it; this is the assertion that keeps them welded.
  it("puts a chat in the row's own state first, so the leading ring agrees", () => {
    const mixed = chipsFor([
      assignment({ observedState: "done", reviewedAt: "2026-07-21T10:00:00.000Z" }),
      assignment({ observedState: "running" }),
      assignment({ observedState: "waiting_input" }),
      assignment({ observedState: "running" }),
    ]);
    expect(mixed.state).toBe("needs-you");
    expect(mixed.chats[0]?.state).toBe(mixed.state);

    const working = chipsFor([
      assignment({ observedState: "done", reviewedAt: "2026-07-21T10:00:00.000Z" }),
      assignment({ observedState: "running" }),
    ]);
    expect(working.state).toBe("working");
    expect(working.chats[0]?.state).toBe(working.state);
  });

  it("finds the ackable chat even when it isn't the leading one", () => {
    const chips = chipsFor([
      assignment({ id: "finished", observedState: "done", reviewedAt: null }),
      assignment({ id: "blocked", observedState: "waiting_input" }),
    ]);
    // waiting_input outranks a finished-unreviewed chat, so the lead is the
    // blocked one — but Mark reviewed belongs to the finished one.
    expect(chips.chats[0]?.assignmentId).toBe("blocked");
    expect(chips.ackableId).toBe("finished");
  });

  it("has nothing to ack once the finished chat is reviewed", () => {
    const chips = chipsFor([
      assignment({ observedState: "done", reviewedAt: "2026-07-21T10:00:00.000Z" }),
      assignment({ observedState: "running" }),
    ]);
    expect(chips.ackableId).toBeNull();
  });
});

describe("capChipStack", () => {
  it("caps the row's stack at two avatars", () => {
    expect(CHIP_STACK_LIMIT).toBe(2);
  });

  it("draws everything and counts nothing while the stack fits", () => {
    expect(capChipStack(["a"], CHIP_STACK_LIMIT)).toEqual({
      shown: ["a"],
      overflow: 0,
    });
    expect(capChipStack(["a", "b"], CHIP_STACK_LIMIT)).toEqual({
      shown: ["a", "b"],
      overflow: 0,
    });
  });

  it("rolls the rest into a count, keeping the row's right edge at three slots", () => {
    expect(capChipStack(["a", "b", "c"], CHIP_STACK_LIMIT)).toEqual({
      shown: ["a", "b"],
      overflow: 1,
    });
    expect(capChipStack(["a", "b", "c", "d", "e"], CHIP_STACK_LIMIT)).toEqual({
      shown: ["a", "b"],
      overflow: 3,
    });
  });

  it("keeps the highest-demand chats — the head of the lane — as the drawn ones", () => {
    const chips = chipsFor([
      assignment({ observedState: "running" }),
      assignment({ observedState: "waiting_input" }),
      assignment({ observedState: "running" }),
    ]);
    const { shown, overflow } = capChipStack(chips.chats, CHIP_STACK_LIMIT);
    expect(shown.map((c) => c.state)).toEqual(["needs-you", "working"]);
    expect(overflow).toBe(1);
  });

  it("copies rather than aliasing its input", () => {
    const items = ["a", "b"];
    const { shown } = capChipStack(items, CHIP_STACK_LIMIT);
    shown.push("c");
    expect(items).toEqual(["a", "b"]);
  });

  it("draws an empty stack as nothing to count", () => {
    expect(capChipStack([], CHIP_STACK_LIMIT)).toEqual({ shown: [], overflow: 0 });
  });
});

describe("liveTaskChips", () => {
  // A collapsed header's job is "is something in here waiting on me" — ONE chip
  // per task, or folding a section stops making a long project short.
  function entry(taskId: string, assignments: Fixture[]) {
    return {
      taskId,
      chip: chipsFor(
        assignments.map((a) => ({ ...a, taskId })),
        taskId,
      ),
    };
  }

  it("shows one chip per TASK however many chats it has", () => {
    const live = liveTaskChips([
      entry("t1", [
        assignment({ observedState: "running" }),
        assignment({ observedState: "running" }),
        assignment({ observedState: "waiting_input" }),
        assignment({ observedState: "running" }),
      ]),
      entry("t2", [
        assignment({ observedState: "running" }),
        assignment({ observedState: "running" }),
      ]),
    ]);
    expect(live.map((c) => c.taskId)).toEqual(["t1", "t2"]);
  });

  it("gives each task its worst state", () => {
    const live = liveTaskChips([
      entry("t1", [
        assignment({ observedState: "running" }),
        assignment({ observedState: "waiting_input" }),
      ]),
      entry("t2", [assignment({ observedState: "running" })]),
    ]);
    expect(live).toEqual([
      { taskId: "t1", harness: "claude", state: "needs-you" },
      { taskId: "t2", harness: "claude", state: "working" },
    ]);
  });

  it("takes the harness of a chat actually in the reported state", () => {
    const live = liveTaskChips([
      entry("t1", [
        assignment({ harness: "claude", observedState: "running" }),
        assignment({ harness: "codex", observedState: "waiting_input" }),
      ]),
    ]);
    expect(live).toEqual([{ taskId: "t1", harness: "codex", state: "needs-you" }]);
  });

  it("sorts needs-you ahead of working so the cap never truncates it", () => {
    const live = liveTaskChips([
      entry("t1", [assignment({ observedState: "running" })]),
      entry("t2", [assignment({ observedState: "running" })]),
      entry("t3", [assignment({ observedState: "running" })]),
      entry("t4", [assignment({ observedState: "waiting_input" })]),
    ]);
    expect(live.map((c) => c.taskId)).toEqual(["t4", "t1", "t2", "t3"]);
    const { shown, overflow } = capChipStack(live, COLLAPSED_CHIP_LIMIT);
    expect(shown.map((c) => c.taskId)).toEqual(["t4", "t1", "t2"]);
    expect(overflow).toBe(1);
  });

  it("says nothing about tasks with no agent, or only finished ones", () => {
    const acked = "2026-07-21T10:00:00.000Z";
    expect(
      liveTaskChips([
        entry("t1", []),
        entry("t2", [assignment({ observedState: "dead" })]),
        entry("t3", [
          assignment({ observedState: "done", reviewedAt: acked }),
          assignment({ observedState: "done", reviewedAt: acked }),
        ]),
      ]),
    ).toEqual([]);
  });

  it("keeps a finished-unreviewed task in the header — it needs you", () => {
    const live = liveTaskChips([
      entry("t1", [assignment({ observedState: "done", reviewedAt: null })]),
    ]);
    expect(live).toEqual([{ taskId: "t1", harness: "claude", state: "needs-you" }]);
  });

  it("caps a collapsed header at three chips", () => {
    expect(COLLAPSED_CHIP_LIMIT).toBe(3);
    const live = liveTaskChips(
      ["t1", "t2", "t3", "t4", "t5"].map((id) =>
        entry(id, [
          assignment({ observedState: "running" }),
          assignment({ observedState: "running" }),
          assignment({ observedState: "running" }),
          assignment({ observedState: "running" }),
        ]),
      ),
    );
    // Five multi-chat tasks: five task chips, three drawn — not twenty discs.
    expect(live).toHaveLength(5);
    const { shown, overflow } = capChipStack(live, COLLAPSED_CHIP_LIMIT);
    expect(shown).toHaveLength(3);
    expect(overflow).toBe(2);
  });
});
