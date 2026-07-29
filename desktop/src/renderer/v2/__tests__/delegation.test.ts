import { describe, expect, it } from "vitest";

import {
  PROMPT_TEMPLATE_FRAMING,
  resolvePromptTemplate,
} from "@hitch/shared";

import { BUILTIN_STARTING_PROMPTS, promptDescription } from "@/lib/chat";
import {
  assignmentsToStopOnDone,
  formatLastSeen,
  isMachineStale,
  machineAvailability,
  MACHINE_STALE_MS,
  observedStateChip,
  type MachineLike,
  type StoppableAssignment,
} from "../delegation";

// A fixed clock so staleness math is deterministic.
const NOW = Date.parse("2026-07-22T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

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

  it("surfaces WHY the sole stale machine is offline (last-seen age + name)", () => {
    const a = machineAvailability([machine("a", 4 * 60_000)], NOW);
    expect(a.disabledReason).toContain("machine-a");
    expect(a.disabledReason).toContain("4m ago");
  });

  it("surfaces the freshest machine's age when several are all stale", () => {
    // b checked in more recently (2m) than a (10m) — the hint uses the freshest.
    const a = machineAvailability(
      [machine("a", 10 * 60_000), machine("b", 2 * 60_000)],
      NOW,
    );
    expect(a.disabledReason).toContain("2m ago");
    expect(a.disabledReason).not.toContain("10m ago");
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

describe("formatLastSeen", () => {
  it("renders minutes, hours, and days coarsely", () => {
    expect(formatLastSeen(iso(30_000), NOW)).toBe("just now");
    expect(formatLastSeen(iso(4 * 60_000), NOW)).toBe("4m ago");
    expect(formatLastSeen(iso(3 * 3_600_000), NOW)).toBe("3h ago");
    expect(formatLastSeen(iso(2 * 86_400_000), NOW)).toBe("2d ago");
  });
});

// THE HONESTY CONTRACT. What the delegate bar shows is the whole prompt — the
// only edit between the textarea and the agent is the server substituting task
// variables. These pin that nothing else can creep back in.
describe("built-in prompts are complete templates", () => {
  it("every built-in carries the task itself, not just an instruction", () => {
    for (const preset of BUILTIN_STARTING_PROMPTS) {
      expect(preset.body).toContain("$TASK_TITLE");
      expect(preset.body).toContain("$TASK_BODY");
      expect(preset.body).toContain("$TASK_ID");
      expect(preset.body.startsWith(PROMPT_TEMPLATE_FRAMING)).toBe(true);
    }
  });

  it("resolves to a prompt containing the task body verbatim", () => {
    const body = "Line one.\n\n  Indented line — keep the  spacing.\nTrailing.";
    const resolved = resolvePromptTemplate(BUILTIN_STARTING_PROMPTS[0].body, {
      id: "task-123",
      title: "Fix the login bug",
      body,
    });
    // The body appears byte-for-byte as a contiguous substring.
    expect(resolved).toContain(body);
    expect(resolved).toContain('"Fix the login bug"');
    expect(resolved).toContain("Task id: task-123");
    expect(resolved).toContain("Read this task and do what it asks.");
    // Nothing is left unsubstituted.
    expect(resolved).not.toContain("$TASK_");
  });

  it("describes a preset by what differs, not the shared framing", () => {
    const described = promptDescription({
      id: "x",
      name: "x",
      body: `${PROMPT_TEMPLATE_FRAMING}\n\nGo wild.`,
    });
    expect(described).toBe("Go wild.");
  });
});

describe("assignmentsToStopOnDone", () => {
  const make = (
    over: Partial<StoppableAssignment> & Pick<StoppableAssignment, "id" | "observedState">,
  ): StoppableAssignment => ({
    taskId: "t1",
    desiredState: "running",
    ...over,
  });

  it("stops live assignments for the task (running desire, non-terminal observed)", () => {
    const rows: StoppableAssignment[] = [
      make({ id: "a1", observedState: "running" }),
      make({ id: "a2", observedState: "waiting_input" }),
      make({ id: "a3", observedState: "spawning" }),
      make({ id: "a4", observedState: "pending" }),
    ];
    expect(assignmentsToStopOnDone(rows, "t1").sort()).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("leaves terminal (done/dead) and already-stopped assignments alone", () => {
    const rows: StoppableAssignment[] = [
      make({ id: "done", observedState: "done" }),
      make({ id: "dead", observedState: "dead" }),
      make({ id: "stopped", observedState: "running", desiredState: "stopped" }),
      make({ id: "live", observedState: "running" }),
    ];
    expect(assignmentsToStopOnDone(rows, "t1")).toEqual(["live"]);
  });

  it("scopes to the given task id", () => {
    const rows: StoppableAssignment[] = [
      make({ id: "mine", taskId: "t1", observedState: "running" }),
      make({ id: "other", taskId: "t2", observedState: "running" }),
    ];
    expect(assignmentsToStopOnDone(rows, "t1")).toEqual(["mine"]);
  });

  it("returns [] for no assignments", () => {
    expect(assignmentsToStopOnDone(undefined, "t1")).toEqual([]);
    expect(assignmentsToStopOnDone([], "t1")).toEqual([]);
  });
});
