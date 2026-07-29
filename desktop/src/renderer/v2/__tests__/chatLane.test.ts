import { describe, expect, it } from "vitest";

import {
  chatAgentDetail,
  chatStatusLine,
  deadLaunchNotice,
  laneRowAction,
  laneSpansMachines,
  type LaneAgentFields,
  type LaneDeadFields,
  type LaneStatusFields,
} from "../chatLane";
import type { DesiredState, ObservedState } from "../delegation";

// A fixed clock so the age wording is deterministic.
const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const agent = (over: Partial<LaneAgentFields> = {}): LaneAgentFields => ({
  harness: "claude",
  model: "claude-opus-4-8",
  effort: "high",
  requestedChatId: null,
  ...over,
});

const status = (
  observedState: ObservedState,
  over: Partial<LaneStatusFields> = {},
): LaneStatusFields => ({
  desiredState: "running",
  observedState,
  createdAt: iso(4 * 60_000),
  ...over,
});

describe("chatAgentDetail", () => {
  it("reads model then effort, from the shared catalog", () => {
    expect(chatAgentDetail(agent())).toBe("Opus 4.8 · High");
    expect(
      chatAgentDetail(agent({ harness: "codex", model: "gpt-5.4-mini", effort: "medium" })),
    ).toBe("GPT-5.4 Mini · Medium");
  });

  it("falls back to the raw id for a model the catalog no longer knows", () => {
    // Honest over pretty: an assignment launched by an older build must show
    // what it actually ran, never a silently substituted current model.
    expect(chatAgentDetail(agent({ model: "claude-opus-3-9", effort: null }))).toBe(
      "claude-opus-3-9",
    );
  });

  it("drops the effort clause when the launch pinned none", () => {
    expect(chatAgentDetail(agent({ effort: null }))).toBe("Opus 4.8");
  });

  it("says a chat was linked from a terminal instead of inventing a model", () => {
    // requested_chat_id set + no model = we ADOPTED a session the user started
    // by hand; Hitch never chose a model, so it must not report one.
    expect(chatAgentDetail(agent({ model: null, requestedChatId: "chat-1" }))).toBe(
      "linked from terminal",
    );
    expect(
      chatAgentDetail(agent({ model: null, effort: null, requestedChatId: "chat-1" })),
    ).toBe("linked from terminal");
  });

  it("says default model for a modelless launch that was NOT adopted", () => {
    expect(chatAgentDetail(agent({ model: null }))).toBe("default model");
  });
});

describe("chatStatusLine", () => {
  it("words the age as when the chat STARTED, never as last activity", () => {
    // created_at is the only timestamp here; a bare "4m" next to a live status
    // would read as "active 4m ago", which we cannot know.
    expect(chatStatusLine(status("running"), NOW)).toBe("Working · started 4m ago");
    expect(chatStatusLine(status("running", { createdAt: iso(30_000) }), NOW)).toBe(
      "Working · started just now",
    );
    expect(
      chatStatusLine(status("running", { createdAt: iso(3 * 3_600_000) }), NOW),
    ).toBe("Working · started 3h ago");
  });

  it("reuses the bar's existing status vocabulary", () => {
    expect(chatStatusLine(status("pending"), NOW)).toContain("Spawning…");
    expect(chatStatusLine(status("spawning"), NOW)).toContain("Spawning…");
    expect(chatStatusLine(status("waiting_input"), NOW)).toContain("Needs you");
    expect(chatStatusLine(status("done"), NOW)).toContain("Done");
  });

  it("says Stopping… while a stop is in flight", () => {
    // desired=stopped with a live observed state: reporting "Working" would be
    // true of the machine and useless to the user who just asked to stop.
    for (const state of ["pending", "spawning", "running", "waiting_input"] as const) {
      expect(chatStatusLine(status(state, { desiredState: "stopped" }), NOW)).toBe(
        "Stopping… · started 4m ago",
      );
    }
  });

  it("keeps the terminal label once the stop has landed", () => {
    expect(chatStatusLine(status("done", { desiredState: "stopped" }), NOW)).toBe(
      "Done · started 4m ago",
    );
    expect(chatStatusLine(status("dead", { desiredState: "stopped" }), NOW)).toBe(
      "Failed · started 4m ago",
    );
  });
});

describe("laneRowAction", () => {
  const row = (
    observedState: ObservedState,
    over: { desiredState?: DesiredState; reviewedAt?: string | null } = {},
  ) => ({
    desiredState: over.desiredState ?? ("running" as DesiredState),
    observedState,
    reviewedAt: over.reviewedAt ?? null,
  });

  it("offers Stop for a live chat that is wanted running", () => {
    for (const state of ["pending", "spawning", "running", "waiting_input"] as const) {
      expect(laneRowAction(row(state))).toBe("stop");
    }
  });

  it("offers Reviewed for a finished, unacked chat", () => {
    expect(laneRowAction(row("done"))).toBe("review");
  });

  it("offers nothing once the finished chat has been acked", () => {
    expect(laneRowAction(row("done", { reviewedAt: iso(0) }))).toBe("none");
  });

  it("offers nothing while a stop is already in flight", () => {
    expect(laneRowAction(row("running", { desiredState: "stopped" }))).toBe("none");
  });

  it("offers nothing for a dead launch", () => {
    expect(laneRowAction(row("dead"))).toBe("none");
  });
});

describe("deadLaunchNotice", () => {
  // ids are uuidv7-shaped in production (creation-ordered); the only property
  // these lean on is that they compare lexicographically.
  const row = (
    id: string,
    createdAt: string,
    observedState: ObservedState,
  ): LaneDeadFields => ({ id, taskId: "t1", createdAt, observedState });

  it("says nothing when there is nothing to report", () => {
    expect(deadLaunchNotice(undefined, "t1", 0)).toBeNull();
    expect(deadLaunchNotice([], "t1", 0)).toBeNull();
    expect(deadLaunchNotice([row("a1", iso(0), "done")], "t1", 0)).toBeNull();
  });

  it("reports a dead latest — the state chatsForTask drops on the floor", () => {
    expect(deadLaunchNotice([row("a1", iso(0), "dead")], "t1", 0)).toBe(
      "The last agent didn’t start.",
    );
  });

  it("stays quiet while something is still in play", () => {
    // A live agent is the thing worth looking at; a stale failure line above it
    // would compete with the row that matters.
    expect(deadLaunchNotice([row("a1", iso(0), "dead")], "t1", 1)).toBeNull();
  });

  it("reads the LATEST assignment by created_at, not input order", () => {
    const rows = [
      row("a2", iso(60_000), "dead"),
      row("a1", iso(600_000), "done"),
    ];
    expect(deadLaunchNotice(rows, "t1", 0)).toBe("The last agent didn’t start.");
    // …and goes quiet once a newer attempt exists, even a still-pending one.
    expect(
      deadLaunchNotice([...rows, row("a3", iso(0), "pending")], "t1", 0),
    ).toBeNull();
  });

  it("breaks created_at ties by id DESC, like the lane's own order", () => {
    const older = row("a1", iso(0), "dead");
    const newer = row("a2", iso(0), "done");
    expect(deadLaunchNotice([older, newer], "t1", 0)).toBeNull();
    expect(deadLaunchNotice([newer, older], "t1", 0)).toBeNull();
  });

  it("ignores other tasks' assignments", () => {
    const mine = { ...row("a1", iso(600_000), "done") };
    const theirs = { ...row("b1", iso(0), "dead"), taskId: "t2" };
    expect(deadLaunchNotice([mine, theirs], "t1", 0)).toBeNull();
  });
});

describe("laneSpansMachines", () => {
  const on = (machineId: string) => ({ assignment: { machineId } });

  it("is false for an empty lane and for one machine", () => {
    expect(laneSpansMachines([])).toBe(false);
    expect(laneSpansMachines([on("m1")])).toBe(false);
    expect(laneSpansMachines([on("m1"), on("m1"), on("m1")])).toBe(false);
  });

  it("is true the moment two chats sit on different machines", () => {
    expect(laneSpansMachines([on("m1"), on("m2")])).toBe(true);
  });
});
