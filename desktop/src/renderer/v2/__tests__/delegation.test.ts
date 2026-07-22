import { describe, expect, it } from "vitest";

import {
  buildDelegatePreamble,
  composeDelegatePrompt,
  deriveBarState,
  isMachineStale,
  machineAvailability,
  MACHINE_STALE_MS,
  observedStateChip,
  selectLatestAssignment,
  type AssignmentLike,
  type MachineLike,
  type ObservedState,
} from "../delegation";

// A fixed clock so staleness math is deterministic.
const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function assignment(
  createdAt: string,
  observedState: ObservedState,
): AssignmentLike & { id: string } {
  return { id: createdAt, createdAt, observedState };
}

describe("selectLatestAssignment", () => {
  it("returns null for empty/undefined input", () => {
    expect(selectLatestAssignment(undefined)).toBeNull();
    expect(selectLatestAssignment([])).toBeNull();
  });

  it("picks the newest by created_at, ignoring input order", () => {
    const a = assignment("2026-07-22T09:00:00.000Z", "done");
    const b = assignment("2026-07-22T11:00:00.000Z", "running");
    const c = assignment("2026-07-22T10:00:00.000Z", "dead");
    expect(selectLatestAssignment([a, b, c])).toBe(b);
    expect(selectLatestAssignment([b, a, c])).toBe(b);
  });

  it("breaks equal-timestamp ties by keeping the last occurrence", () => {
    const a = assignment("2026-07-22T10:00:00.000Z", "done");
    const b = assignment("2026-07-22T10:00:00.000Z", "running");
    // Same createdAt — the later element in the (createdAt-ascending) list wins.
    expect(selectLatestAssignment([a, b])).toBe(b);
  });
});

describe("deriveBarState", () => {
  it("is compose when there is no assignment", () => {
    expect(deriveBarState(null)).toBe("compose");
  });

  it("is active for a live observed_state", () => {
    for (const state of ["pending", "spawning", "running", "waiting_input"] as const) {
      expect(deriveBarState({ createdAt: iso(0), observedState: state })).toBe("active");
    }
  });

  it("is re-delegate once the latest is done or dead (terminal precedence)", () => {
    expect(deriveBarState({ createdAt: iso(0), observedState: "done" })).toBe("re-delegate");
    expect(deriveBarState({ createdAt: iso(0), observedState: "dead" })).toBe("re-delegate");
  });

  it("routes a done latest to re-delegate even past earlier active rows", () => {
    // The newest row is done, so the bar re-delegates regardless of history.
    const history = [
      assignment("2026-07-22T09:00:00.000Z", "running"),
      assignment("2026-07-22T11:00:00.000Z", "done"),
    ];
    expect(deriveBarState(selectLatestAssignment(history))).toBe("re-delegate");
  });
});

describe("observedStateChip", () => {
  it("collapses pending + spawning into Spawning…", () => {
    expect(observedStateChip("pending")).toEqual({ label: "Spawning…", tone: "spawning" });
    expect(observedStateChip("spawning")).toEqual({ label: "Spawning…", tone: "spawning" });
  });

  it("maps running → Working (neutral)", () => {
    expect(observedStateChip("running")).toEqual({ label: "Working", tone: "working" });
  });

  it("maps waiting_input → Needs you (the only amber tone)", () => {
    expect(observedStateChip("waiting_input")).toEqual({
      label: "Needs you",
      tone: "needs-you",
    });
  });

  it("gives done and dead their own terminal chips", () => {
    expect(observedStateChip("done")).toEqual({ label: "Done", tone: "done" });
    expect(observedStateChip("dead")).toEqual({ label: "Failed", tone: "dead" });
  });
});

describe("isMachineStale", () => {
  it("is fresh at exactly the threshold, stale just past it", () => {
    expect(isMachineStale({ lastSeenAt: iso(MACHINE_STALE_MS) }, NOW)).toBe(false);
    expect(isMachineStale({ lastSeenAt: iso(MACHINE_STALE_MS + 1) }, NOW)).toBe(true);
  });

  it("treats a recent heartbeat as fresh", () => {
    expect(isMachineStale({ lastSeenAt: iso(5_000) }, NOW)).toBe(false);
  });
});

describe("machineAvailability", () => {
  const machine = (id: string, msAgo: number): MachineLike => ({
    id,
    name: `machine-${id}`,
    lastSeenAt: iso(msAgo),
  });

  it("disables with a hint and no picker when there are no machines", () => {
    const a = machineAvailability([], NOW);
    expect(a.usable).toEqual([]);
    expect(a.hidePicker).toBe(true);
    expect(a.disabledReason).toMatch(/No machine connected/);
  });

  it("hides the picker and enables delegate with exactly one fresh machine", () => {
    const one = [machine("a", 1_000)];
    const a = machineAvailability(one, NOW);
    expect(a.usable).toEqual(one);
    expect(a.hidePicker).toBe(true);
    expect(a.disabledReason).toBeNull();
  });

  it("disables with a hint when the sole machine is stale", () => {
    const a = machineAvailability([machine("a", MACHINE_STALE_MS + 1)], NOW);
    expect(a.usable).toEqual([]);
    expect(a.hidePicker).toBe(true);
    expect(a.disabledReason).toMatch(/online/);
  });

  it("shows the picker and lists only fresh machines when several exist", () => {
    const fresh = machine("a", 1_000);
    const stale = machine("b", MACHINE_STALE_MS + 1);
    const a = machineAvailability([fresh, stale], NOW);
    expect(a.usable).toEqual([fresh]);
    expect(a.hidePicker).toBe(false);
    expect(a.disabledReason).toBeNull();
  });

  it("disables when every one of several machines is stale", () => {
    const a = machineAvailability(
      [machine("a", MACHINE_STALE_MS + 1), machine("b", MACHINE_STALE_MS + 2)],
      NOW,
    );
    expect(a.usable).toEqual([]);
    expect(a.hidePicker).toBe(false);
    expect(a.disabledReason).toMatch(/online/);
  });
});

describe("buildDelegatePreamble", () => {
  it("embeds the title, the body VERBATIM, and the task id", () => {
    const body = "Line one.\n\n  Indented line — keep the  spacing.\nTrailing.";
    const preamble = buildDelegatePreamble({
      id: "task-123",
      title: "Fix the login bug",
      body,
    });
    // The body appears byte-for-byte as a contiguous substring.
    expect(preamble).toContain(body);
    expect(preamble).toContain('"Fix the login bug"');
    expect(preamble).toContain("Task id: task-123");
    expect(preamble).toContain("hitch");
  });

  it("uses a placeholder when the body is empty/whitespace", () => {
    const preamble = buildDelegatePreamble({ id: "t", title: "T", body: "   " });
    expect(preamble).toContain("No description");
  });
});

describe("composeDelegatePrompt", () => {
  const task = { id: "t1", title: "Task", body: "Do the thing." };

  it("prepends the preamble to a non-empty instruction", () => {
    const result = composeDelegatePrompt(task, "Read this task and do what it asks.");
    expect(result.startsWith(buildDelegatePreamble(task))).toBe(true);
    expect(result).toContain("Read this task and do what it asks.");
    // The instruction survives verbatim after the preamble.
    expect(result.endsWith("Read this task and do what it asks.")).toBe(true);
  });

  it("collapses to just the preamble for a blank instruction", () => {
    expect(composeDelegatePrompt(task, "   ")).toBe(buildDelegatePreamble(task));
  });
});
