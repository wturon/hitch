import { describe, expect, it } from "vitest";

import { clearChatFields } from "@/lib/chat";
import { parseFrontmatter } from "@/lib/frontmatter";
import { deriveTodoGroups, type FileRow } from "@/lib/todos";

// Detach chat (slice 5, acceptance case 16) is `clearChat` → clearChatFields:
// strip every chat-* frontmatter key INCLUDING the pre-bind request flag, so the
// todo derives back to Backlog. useTaskDraft.clearChat is a thin wrapper over
// this pure function; pinning the function pins the detach frontmatter contract.
describe("clearChatFields — detach strips all chat-*/request keys", () => {
  const linked = [
    "---",
    "title: Fix the drag ghost",
    "chat-harness: claude-code",
    "chat-id: sess_123",
    "chat-cwd: /repo",
    "chat-status: working",
    "chat-open-state: pending",
    "---",
    "body stays put",
    "",
  ].join("\n");

  it("removes every chat-* key but keeps title + body byte-for-byte", () => {
    const out = clearChatFields(linked);
    const { frontmatter } = parseFrontmatter(out);
    for (const key of Object.keys(frontmatter)) {
      expect(key.startsWith("chat-")).toBe(false);
    }
    expect(frontmatter.title).toBe("Fix the drag ghost");
    expect(out).toContain("body stays put");
  });

  it("also removes the pre-bind chat-request flag (cancel request)", () => {
    const requested = [
      "---",
      "title: Summoned",
      "chat-request: requested",
      "chat-request-harness: codex",
      "chat-request-id: launch_1",
      "chat-request-error: nope",
      "---",
      "",
    ].join("\n");
    const out = clearChatFields(requested);
    const { frontmatter } = parseFrontmatter(out);
    expect(frontmatter["chat-request"]).toBeUndefined();
    expect(frontmatter["chat-request-harness"]).toBeUndefined();
    expect(frontmatter["chat-request-id"]).toBeUndefined();
    expect(frontmatter["chat-request-error"]).toBeUndefined();
  });

  it("a detached todo derives back to BACKLOG (was NEEDS YOU while linked)", () => {
    const before: FileRow[] = [
      { path: "tasks/t/task.md", content: linked, updatedAt: 1 },
    ];
    // Linked + not working → NEEDS YOU (frontmatter chat-status: working here →
    // WORKING; either way it is NOT backlog while attached).
    expect(deriveTodoGroups(before, []).backlog).toHaveLength(0);

    const after: FileRow[] = [
      { path: "tasks/t/task.md", content: clearChatFields(linked), updatedAt: 2 },
    ];
    const g = deriveTodoGroups(after, []);
    expect(g.backlog.map((t) => t.path)).toEqual(["tasks/t/task.md"]);
    expect(g.needsYou).toHaveLength(0);
    expect(g.working).toHaveLength(0);
  });
});
