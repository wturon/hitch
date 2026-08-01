import { describe, expect, it } from "vitest";

import {
  chatLocationLine,
  chatSearchValue,
  chatStatusWord,
  linkableChats,
  type LinkableChatFields,
} from "../linkableChats";

// A live, adoptable claude chat in project P1. Every case below is this row with
// one field moved, so what the assertion is ABOUT is the override.
function chat(over: Partial<LinkableChatFields> = {}): LinkableChatFields {
  return {
    id: "0199-a",
    machineId: "m1",
    projectId: "p1",
    harness: "claude",
    title: "Chase the EBADF spawn failures",
    sessionId: "sess-a",
    cwd: "/Users/w/code/hitch",
    status: "idle",
    existence: "running",
    lastActivityAt: "2026-08-01T12:00:00.000Z",
    machineName: "studio",
    projectName: "hitch",
    task: null,
    ...over,
  };
}

const forTask = { taskId: "t1", projectId: "p1" };

describe("linkableChats", () => {
  it("mirrors the server's attachable predicate rather than inventing one", () => {
    // Dead, and aged-out-with-no-existence, are exactly what chatIsAttachable
    // rejects — offering either would produce a link the reconciler kills.
    const groups = linkableChats(
      [
        chat({ id: "live" }),
        chat({ id: "dead", status: "dead" }),
        chat({ id: "aged", existence: null }),
      ],
      forTask,
    );
    expect(groups.inProject.map((e) => e.chat.id)).toEqual(["live"]);
    expect(groups.total).toBe(1);
  });

  it("drops a chat with no session id — there is nothing to address", () => {
    const groups = linkableChats([chat({ sessionId: null })], forTask);
    expect(groups.total).toBe(0);
  });

  it("drops a chat already serving THIS task, keeps other-task chats disabled", () => {
    const groups = linkableChats(
      [
        chat({ id: "mine", task: { id: "t1", title: "This task" } }),
        chat({ id: "theirs", task: { id: "t2", title: "Sections v1" } }),
      ],
      forTask,
    );
    expect(groups.inProject).toHaveLength(1);
    expect(groups.inProject[0].chat.id).toBe("theirs");
    // Naming the other task is the useful part — it answers "where did my chat
    // go" without a round trip.
    expect(groups.inProject[0].disabledReason).toBe("On “Sections v1”");
  });

  it("degrades to a generic reason when the other task's title is blank", () => {
    const groups = linkableChats(
      [chat({ task: { id: "t2", title: "   " } })],
      forTask,
    );
    expect(groups.inProject[0].disabledReason).toBe("On another task");
  });

  it("groups by project and orders each group by recency, ties by id DESC", () => {
    const groups = linkableChats(
      [
        chat({ id: "old", lastActivityAt: "2026-08-01T09:00:00.000Z" }),
        chat({ id: "new", lastActivityAt: "2026-08-01T15:00:00.000Z" }),
        chat({ id: "tie-a", lastActivityAt: "2026-08-01T12:00:00.000Z" }),
        chat({ id: "tie-b", lastActivityAt: "2026-08-01T12:00:00.000Z" }),
        chat({ id: "away", projectId: "p2" }),
        chat({ id: "homeless", projectId: null }),
      ],
      forTask,
    );
    expect(groups.inProject.map((e) => e.chat.id)).toEqual([
      "new",
      "tie-b",
      "tie-a",
      "old",
    ]);
    // Same timestamp, so these fall to the id DESC tiebreak too.
    expect(groups.elsewhere.map((e) => e.chat.id)).toEqual(["homeless", "away"]);
    expect(groups.total).toBe(6);
  });

  it("puts everything under elsewhere for a task with no project", () => {
    const groups = linkableChats([chat()], { taskId: "t1", projectId: null });
    expect(groups.inProject).toHaveLength(0);
    expect(groups.elsewhere).toHaveLength(1);
  });

  it("survives an undefined list (the query hasn't landed)", () => {
    expect(linkableChats(undefined, forTask)).toEqual({
      inProject: [],
      elsewhere: [],
      total: 0,
    });
  });
});

describe("chatStatusWord", () => {
  it("lets existence outrank a status that would overstate the chat", () => {
    // Both derive to `idle` server-side, and both would read as a session
    // sitting in a terminal waiting for you. Neither is.
    expect(chatStatusWord({ status: "idle", existence: "dormant" }).label).toBe(
      "Dormant",
    );
    expect(chatStatusWord({ status: "idle", existence: "pending" }).label).toBe(
      "Starting…",
    );
  });

  it("spends the one amber mark on needs-you only", () => {
    expect(chatStatusWord({ status: "waiting_input", existence: "running" })).toEqual({
      label: "Needs you",
      needsYou: true,
    });
    for (const status of ["busy", "idle"] as const) {
      expect(chatStatusWord({ status, existence: "running" }).needsYou).toBe(false);
    }
  });

  it("names a working chat 'Working', matching the lane's vocabulary", () => {
    expect(chatStatusWord({ status: "busy", existence: "running" }).label).toBe(
      "Working",
    );
  });
});

describe("chatLocationLine", () => {
  it("leads with the cwd — the only honest label for an unhitched folder", () => {
    expect(chatLocationLine(chat({ cwd: "/Users/w/code/scratch", projectName: null })))
      .toBe("/Users/w/code/scratch · Idle");
  });

  it("falls back to the project, then to a placeholder", () => {
    expect(chatLocationLine(chat({ cwd: null }))).toBe("hitch · Idle");
    expect(chatLocationLine(chat({ cwd: "  ", projectName: null }))).toBe(
      "unknown folder · Idle",
    );
  });
});

describe("chatSearchValue", () => {
  it("carries everything a user might type to find a session again", () => {
    const value = chatSearchValue(chat());
    for (const part of ["EBADF", "code/hitch", "claude", "studio"]) {
      expect(value).toContain(part);
    }
  });
});
