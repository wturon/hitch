import { describe, expect, it } from "vitest";
// The sidebar-badge projection of the unified derivation core — the SAME
// module the Todos list derives with, consumed server-side by
// convex/files.ts chatStatusCounts. These tests pin the badge-count semantics
// in both chat-resolution modes so the badges can never disagree with the
// list: frontmatter-only (no index — the coexistence read path) and
// index-supplied (live rows authoritative; a missing row = dead chat).
import { indexChats, taskCountedGroup, type LiveChatRow } from "../todos";

function fm(lines: Record<string, string>): string {
  const body = Object.entries(lines)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${body}\n---\nbody text`;
}

const CHAT = { "chat-harness": "codex", "chat-id": "abc123" };

function liveRow(status: string, chatId = "abc123"): LiveChatRow {
  return {
    harness: "codex",
    chatId,
    status,
    lastEventAt: 100,
    updatedAt: 200,
  };
}

describe("taskCountedGroup — frontmatter-only mode (no index)", () => {
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

  // The compat shim died with the board in slice 6b — `status:` is inert. It
  // never counts and never overrides the chat-derived group; only the
  // `completed-at:`/`archived-at:` timestamps the migration writes matter.
  describe("legacy status: is inert (post-slice-6b)", () => {
    it("status: done / archived alone → uncounted backlog (null)", () => {
      expect(taskCountedGroup(fm({ status: "done" }))).toBeNull();
      expect(taskCountedGroup(fm({ status: "archived" }))).toBeNull();
    });

    it("status: never overrides a bound working chat", () => {
      // Previously `status: done` masked the chat; now the chat state wins.
      expect(
        taskCountedGroup(fm({ ...CHAT, "chat-status": "working", status: "done" })),
      ).toBe("working");
      expect(
        taskCountedGroup(fm({ ...CHAT, "chat-status": "working", status: "in-review" })),
      ).toBe("working");
    });
  });
});

// Index-supplied mode: what the Convex badge query runs (the server always has
// the full chats table in hand, so it always passes the index). These pin the
// exact stale-frontmatter cases slice 1 was designed to fix — the badge must
// agree with the list on them.
describe("taskCountedGroup — index-supplied mode (live rows authoritative)", () => {
  it("stale projected chat-status: working + live row idle → needs-you, NOT working", () => {
    const chats = indexChats([liveRow("idle")]);
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "working" }), chats)).toBe(
      "needs-you",
    );
  });

  it("frontmatter chat ref + row missing from the index → needs-you (dead chat)", () => {
    // Non-empty index whose rows don't include this chat-id.
    const chats = indexChats([liveRow("working", "other-chat")]);
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "working" }), chats)).toBe(
      "needs-you",
    );
    // Empty index (project has no live rows at all) reads the same way.
    expect(taskCountedGroup(fm({ ...CHAT }), indexChats([]))).toBe("needs-you");
  });

  it("live row working → working, regardless of frontmatter status", () => {
    const chats = indexChats([liveRow("working")]);
    // no projected chat-status at all
    expect(taskCountedGroup(fm({ ...CHAT }), chats)).toBe("working");
    // stale projected waiting
    expect(taskCountedGroup(fm({ ...CHAT, "chat-status": "waiting" }), chats)).toBe(
      "working",
    );
    // legacy status: is inert, live row still wins
    expect(taskCountedGroup(fm({ ...CHAT, status: "in-review" }), chats)).toBe(
      "working",
    );
  });

  it("completed/archived/requested precedence is unchanged by the index", () => {
    const chats = indexChats([liveRow("working")]);
    expect(taskCountedGroup(fm({ ...CHAT, "completed-at": "x" }), chats)).toBeNull();
    expect(taskCountedGroup(fm({ ...CHAT, "archived-at": "x" }), chats)).toBeNull();
    expect(
      taskCountedGroup(fm({ "chat-request": "requested" }), indexChats([])),
    ).toBe("working");
  });
});
