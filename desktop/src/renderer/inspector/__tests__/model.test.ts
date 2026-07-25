import { describe, expect, it } from "vitest";

import {
  STALE_SNAPSHOT_MS,
  evidenceEntries,
  filterCounts,
  formatAge,
  hasStaleEvidence,
  isInWindow,
  isUnattached,
  matchesFilter,
  shortCwd,
  shortSession,
  snapshotHealth,
  type InspectorChatLike,
  type InspectorMachineLike,
} from "../model";

const NOW = Date.parse("2026-07-25T12:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const machine = (over: Partial<InspectorMachineLike> = {}): InspectorMachineLike => ({
  id: "m1",
  name: "laptop",
  lastSeenAt: at(5_000),
  chatSnapshotAt: at(5_000),
  chatWindowSince: at(24 * 3600_000),
  chatWindowCap: 60,
  chatWindowTruncated: false,
  ...over,
});

const chat = (over: Partial<InspectorChatLike> = {}): InspectorChatLike => ({
  id: "c1",
  title: "hitch",
  harness: "claude-code",
  sessionId: "0f2ca91b-1234",
  cwd: "/Users/w/code/hitch",
  machineId: "m1",
  machineName: "laptop",
  projectId: null,
  projectName: null,
  task: null,
  handle: null,
  existence: "running",
  activity: "working",
  block: null,
  status: "busy",
  evidence: { source: "claude-pidfile", self: "busy" },
  pid: 48213,
  processStartedAt: 1753000000,
  lastObservedAt: at(5_000),
  lastActivityAt: at(5_000),
  ...over,
});

describe("formatAge", () => {
  it("uses a single unit at every scale", () => {
    expect(formatAge(null)).toBe("—");
    expect(formatAge(400)).toBe("0s");
    expect(formatAge(12_000)).toBe("12s");
    expect(formatAge(4 * 60_000)).toBe("4m");
    expect(formatAge(6 * 3600_000)).toBe("6h");
    expect(formatAge(3 * 24 * 3600_000)).toBe("3d");
  });
});

describe("snapshotHealth", () => {
  it("is fresh inside the window and stale past it", () => {
    expect(snapshotHealth(machine({ chatSnapshotAt: at(30_000) }), NOW).health).toBe("fresh");
    expect(
      snapshotHealth(machine({ chatSnapshotAt: at(STALE_SNAPSHOT_MS + 1_000) }), NOW).health,
    ).toBe("stale");
  });

  it("distinguishes 'never snapshotted' from 'stale'", () => {
    expect(snapshotHealth(machine({ chatSnapshotAt: null }), NOW)).toEqual({
      health: "never",
      ageMs: null,
    });
  });
});

describe("hasStaleEvidence", () => {
  it("compares the row against its machine's LAST snapshot, not the wall clock", () => {
    // Snapshot is old but the row rode that very snapshot — not stale evidence,
    // it's the freshest thing the machine has said.
    const m = machine({ chatSnapshotAt: at(10 * 60_000) });
    expect(hasStaleEvidence(chat({ lastObservedAt: at(10 * 60_000) }), m, NOW)).toBe(false);
    // Same snapshot, but this row was NOT in it.
    expect(hasStaleEvidence(chat({ lastObservedAt: at(30 * 60_000) }), m, NOW)).toBe(true);
  });

  it("tolerates sub-second skew between the two stamps", () => {
    const m = machine({ chatSnapshotAt: at(5_000) });
    expect(hasStaleEvidence(chat({ lastObservedAt: at(5_500) }), m, NOW)).toBe(false);
  });

  it("falls back to the wall clock when the machine has no coverage recorded", () => {
    const m = machine({ chatSnapshotAt: null });
    expect(hasStaleEvidence(chat({ lastObservedAt: at(10_000) }), m, NOW)).toBe(false);
    expect(hasStaleEvidence(chat({ lastObservedAt: at(STALE_SNAPSHOT_MS + 1) }), m, NOW)).toBe(true);
  });

  it("treats a never-observed row that still claims existence as stale", () => {
    expect(hasStaleEvidence(chat({ lastObservedAt: null }), machine(), NOW)).toBe(true);
  });

  it("excludes rows with no existence — absence IS the evidence, not stale evidence", () => {
    const swept = chat({ existence: null, status: "dead", lastObservedAt: at(60 * 60_000) });
    expect(hasStaleEvidence(swept, machine(), NOW)).toBe(false);
  });
});

describe("attachment + window predicates", () => {
  it("is unattached only with no task, no project and no handle", () => {
    expect(isUnattached(chat())).toBe(true);
    expect(isUnattached(chat({ task: { id: "t", title: "ship it" } }))).toBe(false);
    expect(isUnattached(chat({ projectId: "p" }))).toBe(false);
    expect(isUnattached(chat({ handle: { cmux: "surface:7" } }))).toBe(false);
  });

  it("reads null existence as 'absent from the last snapshot'", () => {
    expect(isInWindow(chat())).toBe(true);
    expect(isInWindow(chat({ existence: null }))).toBe(false);
  });
});

describe("filters", () => {
  const m = machine();

  it("keeps dormant chats in 'live' — only dead is terminal", () => {
    const dormant = chat({ existence: "dormant", activity: "idle", status: "idle" });
    expect(matchesFilter("live", dormant, m, NOW)).toBe(true);
    expect(matchesFilter("live", chat({ status: "dead", existence: null }), m, NOW)).toBe(false);
  });

  it("selects blocked by the block axis, not by the derived status", () => {
    // Dormant + a lingering block: the server derives idle (a block never
    // outlives its process), but the axis is still what 'blocked' filters on.
    const stale = chat({ existence: "dormant", block: "permission", status: "idle" });
    expect(matchesFilter("blocked", stale, m, NOW)).toBe(true);
    expect(matchesFilter("blocked", chat(), m, NOW)).toBe(false);
  });

  it("counts every filter over the whole set", () => {
    const chats = [
      chat({ id: "a" }),
      // Swept dead: NOT stale evidence — its absence is the freshest fact we have.
      chat({ id: "b", status: "dead", existence: null, lastObservedAt: at(60 * 60_000) }),
      chat({ id: "c", block: "question", status: "waiting_input", task: { id: "t", title: "x" } }),
      // Still claims to be running, but missed the machine's last tick.
      chat({ id: "d", lastObservedAt: at(60 * 60_000) }),
    ];
    const counts = filterCounts(chats, new Map([[m.id, m]]), NOW);
    expect(counts).toEqual({ all: 4, live: 3, blocked: 1, unattached: 3, stale: 1 });
  });
});

describe("evidenceEntries", () => {
  it("hoists source first and keeps the rest in order", () => {
    expect(evidenceEntries({ mtimeAge: 1.2, source: "claude-pidfile", self: "busy" })).toEqual([
      { key: "source", value: "claude-pidfile" },
      { key: "mtimeAge", value: "1.2" },
      { key: "self", value: "busy" },
    ]);
  });

  it("survives a missing or non-object blob", () => {
    expect(evidenceEntries(null)).toEqual([]);
    expect(evidenceEntries(undefined)).toEqual([]);
    expect(evidenceEntries("raw")).toEqual([{ key: "evidence", value: "raw" }]);
  });

  it("prints null explicitly — 'we recorded nothing' and 'we recorded null' differ", () => {
    expect(evidenceEntries({ marker: null })).toEqual([{ key: "marker", value: "null" }]);
  });
});

describe("row labels", () => {
  it("keeps the discriminating tail of a cwd", () => {
    expect(shortCwd("/Users/w/code/hitch")).toBe("…/code/hitch");
    expect(shortCwd("/tmp")).toBe("/tmp");
    expect(shortCwd(null)).toBe("no cwd");
  });

  it("shortens a session id without inventing one", () => {
    expect(shortSession("0f2ca91b-dead-beef")).toBe("0f2ca91b");
    expect(shortSession("abc")).toBe("abc");
    expect(shortSession(null)).toBe("—");
  });
});
