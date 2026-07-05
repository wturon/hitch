import { describe, expect, it } from "vitest";
// The pure server-side predicate that backs the sidebar badge counts
// (convex/files.ts chatStatusCounts). Imported by relative path — it has no
// Convex imports, so it runs headlessly here. This guards that the badge model
// stays in lockstep with the Todos list grouping (lib/todos.ts groupOf).
import { taskCountedGroup } from "../../../../../convex/todoGroups";

function fm(lines: Record<string, string>): string {
  const body = Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${body}\n---\nbody text`;
}

const CHAT = { "chat-harness": "codex", "chat-id": "abc123" };

describe("taskCountedGroup", () => {
  it("archived → uncounted (null)", () => {
    expect(taskCountedGroup(fm({ "archived-at": "2026-07-04T00:00:00Z" }))).toBeNull();
    // archived wins even over a bound working chat
    expect(
      taskCountedGroup(
        fm({ ...CHAT, "chat-status": "working", "archived-at": "2026-07-04T00:00:00Z" }),
      ),
    ).toBeNull();
  });

  it("completed → uncounted (null), even with a live chat", () => {
    expect(taskCountedGroup(fm({ "completed-at": "2026-07-04T00:00:00Z" }))).toBeNull();
    expect(
      taskCountedGroup(fm({ ...CHAT, "chat-status": "working", "completed-at": "x" })),
    ).toBeNull();
  });

  it("a pending/failed summon flag → working", () => {
    expect(taskCountedGroup(fm({ "chat-request": "requested" }))).toBe("working");
    expect(taskCountedGroup(fm({ "chat-request": "failed" }))).toBe("working");
  });

  it("a bound chat that is mid-turn → working (incl. aliases)", () => {
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "working" }))).toBe("working");
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "running" }))).toBe("working");
  });

  it("a bound chat that isn't working → needs-you", () => {
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "needs-input" }))).toBe(
      "needs-you",
    );
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "waiting" }))).toBe("needs-you");
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "idle" }))).toBe("needs-you");
    // bound with no projected status is still attached → needs-you
    expect(taskCountedGroup(fm({ ...CHAT }))).toBe("needs-you");
  });

  it("a bare chat-id without a known harness is NOT a bound chat", () => {
    expect(taskCountedGroup(fm({ "chat-id": "abc123" }))).toBeNull();
    expect(taskCountedGroup(fm({ "chat-harness": "codex" }))).toBeNull();
  });

  it("no chat, no request → backlog (uncounted)", () => {
    expect(taskCountedGroup(fm({ title: "Just a todo" }))).toBeNull();
    expect(taskCountedGroup("no frontmatter at all")).toBeNull();
  });

  describe("compat shim (legacy status:)", () => {
    it("legacy done/archived are uncounted", () => {
      expect(taskCountedGroup(fm({ status: "done" }))).toBeNull();
      expect(taskCountedGroup(fm({ status: "archived" }))).toBeNull();
      // legacy done wins over a live working chat, same as completed-at
      expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "working", status: "done" }))).toBeNull();
    });

    it("any other legacy status is ignored (falls through to its chat state)", () => {
      // unknown legacy status alone → backlog (uncounted)
      expect(taskCountedGroup(fm({ status: "in-review" }))).toBeNull();
      // unknown legacy status + a bound working chat → still working
      expect(
        taskCountedGroup(fm({ ...CHAT, "chat-status": "working", status: "in-review" })),
      ).toBe("working");
    });
  });
});
