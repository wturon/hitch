import { describe, expect, it } from "vitest";

import {
  deriveTodoGroups,
  indexChats,
  prependBacklogPath,
  reorderBacklog,
  type FileRow,
  type LiveChatRow,
} from "../todos";
import type { Harness } from "../chat";

// Build a task FileRow at tasks/<slug>/task.md with the given frontmatter keys
// and an optional body. Keys with `undefined` values are omitted so a fixture
// reads only the frontmatter it cares about.
function task(
  slug: string,
  fm: Record<string, string | undefined>,
  opts: { updatedAt?: number; deleted?: boolean; body?: string } = {},
): FileRow {
  const lines = Object.entries(fm)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  const content = `---\n${lines.join("\n")}\n---\n${opts.body ?? ""}`;
  return {
    path: `tasks/${slug}/task.md`,
    content,
    updatedAt: opts.updatedAt ?? 0,
    deleted: opts.deleted,
  };
}

const paths = (todos: { path: string }[]) => todos.map((t) => t.path);

// A live chats-table row for the optional index input.
function chatRow(
  chatId: string,
  status: string,
  opts: { harness?: Harness; lastEventAt?: number; updatedAt?: number } = {},
): LiveChatRow {
  return {
    harness: opts.harness ?? "claude-code",
    chatId,
    status,
    lastEventAt: opts.lastEventAt ?? 0,
    updatedAt: opts.updatedAt ?? 0,
  };
}

describe("deriveTodoGroups — group predicate (top-down, first match wins)", () => {
  it("archived (archived-at) is excluded from all groups and counted", () => {
    const g = deriveTodoGroups(
      [task("a", { "archived-at": "2026-01-01T00:00:00Z" })],
      [],
    );
    expect(g.archivedCount).toBe(1);
    expect(g.needsYou).toHaveLength(0);
    expect(g.working).toHaveLength(0);
    expect(g.backlog).toHaveLength(0);
    expect(g.done).toHaveLength(0);
  });

  it("archived wins over completed (predicate 1 before 2)", () => {
    const g = deriveTodoGroups(
      [
        task("a", {
          "archived-at": "2026-01-01T00:00:00Z",
          "completed-at": "2026-01-02T00:00:00Z",
        }),
      ],
      [],
    );
    expect(g.archivedCount).toBe(1);
    expect(g.done).toHaveLength(0);
  });

  it("completed-at → done", () => {
    const g = deriveTodoGroups(
      [task("a", { "completed-at": "2026-01-01T00:00:00Z" })],
      [],
    );
    expect(paths(g.done)).toEqual(["tasks/a/task.md"]);
  });

  it("done wins over a chat (predicate 2 before 3/4/5)", () => {
    const g = deriveTodoGroups(
      [
        task("a", {
          "completed-at": "2026-01-01T00:00:00Z",
          "chat-harness": "codex",
          "chat-id": "x1",
          "chat-status": "working",
        }),
      ],
      [],
    );
    expect(paths(g.done)).toEqual(["tasks/a/task.md"]);
    expect(g.working).toHaveLength(0);
  });

  it("a pending request → working (fold-in), even without a chat", () => {
    const g = deriveTodoGroups(
      [task("a", { "chat-request": "requested", "chat-request-harness": "codex" })],
      [],
    );
    expect(paths(g.working)).toEqual(["tasks/a/task.md"]);
  });

  it("a failed request → working (predicate 3), not needs-you", () => {
    const g = deriveTodoGroups(
      [task("a", { "chat-request": "failed", "chat-request-harness": "codex" })],
      [],
    );
    expect(paths(g.working)).toEqual(["tasks/a/task.md"]);
    expect(g.needsYou).toHaveLength(0);
  });

  it("bound chat + status working → working (predicate 4)", () => {
    const g = deriveTodoGroups(
      [
        task("a", {
          "chat-harness": "claude-code",
          "chat-id": "x1",
          "chat-status": "working",
        }),
      ],
      [],
    );
    expect(paths(g.working)).toEqual(["tasks/a/task.md"]);
  });

  it("bound chat + not working → needs-you (predicate 5)", () => {
    const waiting = task("a", {
      "chat-harness": "claude-code",
      "chat-id": "x1",
      "chat-status": "waiting",
    });
    const needsInput = task("b", {
      "chat-harness": "claude-code",
      "chat-id": "x2",
      "chat-status": "needs-input",
    });
    const noStatus = task("c", { "chat-harness": "codex", "chat-id": "x3" });
    const g = deriveTodoGroups([waiting, needsInput, noStatus], []);
    expect(new Set(paths(g.needsYou))).toEqual(
      new Set(["tasks/a/task.md", "tasks/b/task.md", "tasks/c/task.md"]),
    );
    expect(g.working).toHaveLength(0);
  });

  it("no chat / no request / not done → backlog (predicate 6)", () => {
    const g = deriveTodoGroups([task("a", { title: "Plain" })], []);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });

  it("a bound chat with an unknown chat-status parks in needs-you", () => {
    // Unknown chat-status normalizes to null (not 'working') → predicate 5.
    const g = deriveTodoGroups(
      [task("a", { "chat-harness": "codex", "chat-id": "x1", "chat-status": "zzz" })],
      [],
    );
    expect(paths(g.needsYou)).toEqual(["tasks/a/task.md"]);
  });

  it("an incomplete chat ref (id without harness) is not a chat → backlog", () => {
    const g = deriveTodoGroups([task("a", { "chat-id": "x1" })], []);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });
});

// The compat shim died with the board in slice 6b: `status:` is now inert. The
// daemon migration (slice 6a) rewrites any surviving `status:` into
// `completed-at:`/`archived-at:` timestamps, which are the only signals the
// derivation reads. These fixtures pin that `status:` no longer moves a todo.
describe("deriveTodoGroups — legacy status: is inert (post-slice-6b)", () => {
  it("status: done alone → backlog (no completed-at)", () => {
    const g = deriveTodoGroups([task("a", { status: "done" })], []);
    expect(paths(g.done)).toEqual([]);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });

  it("status: archived alone → backlog, not archived (no archived-at)", () => {
    const g = deriveTodoGroups([task("a", { status: "archived" })], []);
    expect(g.archivedCount).toBe(0);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });

  it("any status value is ignored → backlog", () => {
    const g = deriveTodoGroups(
      [task("a", { status: "waiting" }), task("b", { status: "review" })],
      [],
    );
    expect(new Set(paths(g.backlog))).toEqual(
      new Set(["tasks/a/task.md", "tasks/b/task.md"]),
    );
  });

  it("absent status → backlog", () => {
    const g = deriveTodoGroups([task("a", {})], []);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });

  it("completed-at wins regardless of a stale status:", () => {
    const g = deriveTodoGroups(
      [task("a", { status: "in-progress", "completed-at": "2026-07-05" })],
      [],
    );
    expect(paths(g.done)).toEqual(["tasks/a/task.md"]);
  });
});

describe("deriveTodoGroups — intra-group sorts", () => {
  it("needs-you: blocked/failed first, then updatedAt desc", () => {
    const plainOld = task(
      "plain-old",
      { "chat-harness": "codex", "chat-id": "p1", "chat-status": "waiting" },
      { updatedAt: 100 },
    );
    const plainNew = task(
      "plain-new",
      { "chat-harness": "codex", "chat-id": "p2", "chat-status": "waiting" },
      { updatedAt: 400 },
    );
    const blockedOld = task(
      "blocked-old",
      { "chat-harness": "claude-code", "chat-id": "b1", "chat-status": "needs-input" },
      { updatedAt: 200 },
    );
    const blockedNew = task(
      "blocked-new",
      { "chat-harness": "claude-code", "chat-id": "b2", "chat-status": "needs-input" },
      { updatedAt: 300 },
    );
    const g = deriveTodoGroups([plainOld, plainNew, blockedOld, blockedNew], []);
    expect(paths(g.needsYou)).toEqual([
      "tasks/blocked-new/task.md", // blocked, newest
      "tasks/blocked-old/task.md", // blocked, older
      "tasks/plain-new/task.md", // not-working, newest
      "tasks/plain-old/task.md", // not-working, oldest
    ]);
  });

  it("working: updatedAt desc", () => {
    const a = task(
      "a",
      { "chat-harness": "codex", "chat-id": "x1", "chat-status": "working" },
      { updatedAt: 10 },
    );
    const b = task("b", { "chat-request": "requested" }, { updatedAt: 30 });
    const c = task(
      "c",
      { "chat-harness": "codex", "chat-id": "x2", "chat-status": "working" },
      { updatedAt: 20 },
    );
    const g = deriveTodoGroups([a, b, c], []);
    expect(paths(g.working)).toEqual([
      "tasks/b/task.md",
      "tasks/c/task.md",
      "tasks/a/task.md",
    ]);
  });

  it("done: completed-at desc", () => {
    const a = task("a", { "completed-at": "2026-01-01T00:00:00Z" });
    const b = task("b", { "completed-at": "2026-03-01T00:00:00Z" });
    const c = task("c", { "completed-at": "2026-02-01T00:00:00Z" });
    const g = deriveTodoGroups([a, b, c], []);
    expect(paths(g.done)).toEqual([
      "tasks/b/task.md",
      "tasks/c/task.md",
      "tasks/a/task.md",
    ]);
  });
});

describe("deriveTodoGroups — backlog order partition", () => {
  it("ordered-present kept in order sequence, absentees appended by updatedAt desc", () => {
    const a = task("a", {}, { updatedAt: 1 });
    const b = task("b", {}, { updatedAt: 2 });
    const absOld = task("abs-old", {}, { updatedAt: 500 });
    const absNew = task("abs-new", {}, { updatedAt: 900 });
    const order = ["tasks/b/task.md", "tasks/a/task.md"]; // manual: b before a
    const g = deriveTodoGroups([a, b, absOld, absNew], order);
    expect(paths(g.backlog)).toEqual([
      "tasks/b/task.md", // ordered
      "tasks/a/task.md", // ordered
      "tasks/abs-new/task.md", // absentee, newest first
      "tasks/abs-old/task.md",
    ]);
  });

  it("stale paths in order (no matching backlog task) are ignored", () => {
    const a = task("a", {}, { updatedAt: 1 });
    const order = [
      "tasks/ghost/task.md", // deleted/completed/relinked — no such backlog row
      "tasks/a/task.md",
    ];
    const g = deriveTodoGroups([a], order);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });

  it("duplicate present path in order renders once, at its first occurrence", () => {
    // Legal state: slice 5's uncheck prepends [path, ...existingOrder] without
    // pruning the stored array, so a completed-then-unchecked task can appear
    // twice. First occurrence wins.
    const a = task("a", {}, { updatedAt: 1 });
    const b = task("b", {}, { updatedAt: 2 });
    const order = [
      "tasks/a/task.md", // unchecked → prepended
      "tasks/b/task.md",
      "tasks/a/task.md", // stale earlier entry of the same path
    ];
    const g = deriveTodoGroups([a, b], order);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md", "tasks/b/task.md"]);
  });

  it("duplicate stale path in order stays a no-op", () => {
    const a = task("a", {}, { updatedAt: 1 });
    const order = [
      "tasks/ghost/task.md",
      "tasks/a/task.md",
      "tasks/ghost/task.md", // duplicate of a path with no matching backlog row
    ];
    const g = deriveTodoGroups([a], order);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
  });

  it("empty order → pure updatedAt desc", () => {
    const a = task("a", {}, { updatedAt: 100 });
    const b = task("b", {}, { updatedAt: 300 });
    const c = task("c", {}, { updatedAt: 200 });
    const g = deriveTodoGroups([a, b, c], []);
    expect(paths(g.backlog)).toEqual([
      "tasks/b/task.md",
      "tasks/c/task.md",
      "tasks/a/task.md",
    ]);
  });
});

describe("deriveTodoGroups — exclusions", () => {
  it("tombstoned (deleted) files are excluded from every group and the count", () => {
    const g = deriveTodoGroups(
      [
        task("a", { "archived-at": "2026-01-01T00:00:00Z" }, { deleted: true }),
        task("b", { "completed-at": "2026-01-01T00:00:00Z" }, { deleted: true }),
        task("c", {}, { deleted: true }),
      ],
      [],
    );
    expect(g.archivedCount).toBe(0);
    expect(g.done).toHaveLength(0);
    expect(g.backlog).toHaveLength(0);
  });

  it("non-task files (not tasks/<slug>/task.md) are excluded", () => {
    const notes: FileRow = {
      path: "notes/idea/index.md",
      content: "---\ntitle: Idea\n---\nbody",
      updatedAt: 1,
    };
    const attachment: FileRow = {
      path: "tasks/a/image.png",
      content: "binary-ish",
      updatedAt: 1,
    };
    const projectConfig: FileRow = {
      path: ".hitch/project.json",
      content: "{}",
      updatedAt: 1,
    };
    const realTask = task("a", {});
    const g = deriveTodoGroups([notes, attachment, projectConfig, realTask], []);
    expect(paths(g.backlog)).toEqual(["tasks/a/task.md"]);
    expect(g.archivedCount).toBe(0);
  });
});

describe("deriveTodoGroups — Todo projection", () => {
  it("title falls back to slug; content is the raw file text", () => {
    const withTitle = task("a", { title: "Real Title" }, { body: "hello" });
    const noTitle = task("b", {});
    const g = deriveTodoGroups([withTitle, noTitle], []);
    const byPath = Object.fromEntries(g.backlog.map((t) => [t.slug, t]));
    expect(byPath.a.title).toBe("Real Title");
    expect(byPath.a.content).toBe(withTitle.content);
    expect(byPath.b.title).toBe("b"); // slug fallback
  });
});

describe("deriveTodoGroups — live chat index (resolveChatState seam)", () => {
  const attached = (slug: string, chatId: string, fmStatus?: string) =>
    task(slug, {
      "chat-harness": "claude-code",
      "chat-id": chatId,
      "chat-status": fmStatus,
    });

  it("live row wins over stale projected frontmatter: fm working, row idle → needs-you", () => {
    const chats = indexChats([chatRow("x1", "idle")]);
    const g = deriveTodoGroups([attached("a", "x1", "working")], [], chats);
    expect(paths(g.needsYou)).toEqual(["tasks/a/task.md"]);
    expect(g.working).toHaveLength(0);
  });

  it("live row wins in the other direction too: fm waiting, row working → working", () => {
    const chats = indexChats([chatRow("x1", "working")]);
    const g = deriveTodoGroups([attached("a", "x1", "waiting")], [], chats);
    expect(paths(g.working)).toEqual(["tasks/a/task.md"]);
  });

  it("index supplied + no row → needs-you, even when stale frontmatter says working", () => {
    // A deleted/missing chats row must not silently un-attach a todo (it parks
    // in NEEDS YOU until the user detaches deliberately) — and with the index
    // supplied the live table is authoritative, so a leftover projected
    // `chat-status: working` is NOT read: a dead chat can't strand the todo in
    // WORKING.
    const chats = indexChats([chatRow("other", "working")]);
    const noStatus = attached("a", "x1");
    const staleWorking = attached("b", "x2", "working");
    const g = deriveTodoGroups([noStatus, staleWorking], [], chats);
    expect(new Set(paths(g.needsYou))).toEqual(
      new Set(["tasks/a/task.md", "tasks/b/task.md"]),
    );
    expect(g.working).toHaveLength(0);
    expect(g.backlog).toHaveLength(0);
  });

  it("same stale frontmatter WITHOUT an index → working (coexistence mode unchanged)", () => {
    const g = deriveTodoGroups([attached("b", "x2", "working")], []);
    expect(paths(g.working)).toEqual(["tasks/b/task.md"]);
  });

  it("index keyed by harness too: same chat id on another harness doesn't resolve", () => {
    const chats = indexChats([chatRow("x1", "working", { harness: "codex" })]);
    const g = deriveTodoGroups([attached("a", "x1", "waiting")], [], chats);
    // claude-code:x1 has no row → status unknown → needs-you.
    expect(paths(g.needsYou)).toEqual(["tasks/a/task.md"]);
  });

  it("chat recency from rows drives needs-you/working sorts, overriding file updatedAt order", () => {
    const chats = indexChats([
      chatRow("w1", "working", { lastEventAt: 100, updatedAt: 50 }),
      chatRow("w2", "working", { lastEventAt: 20, updatedAt: 900 }), // max = 900
      chatRow("n1", "waiting", { lastEventAt: 10, updatedAt: 10 }),
      chatRow("n2", "waiting", { lastEventAt: 700, updatedAt: 5 }), // max = 700
    ]);
    const files = [
      // File recency says a > b, row recency says b (900) > a (100).
      task("a", { "chat-harness": "claude-code", "chat-id": "w1" }, { updatedAt: 500 }),
      task("b", { "chat-harness": "claude-code", "chat-id": "w2" }, { updatedAt: 400 }),
      // Same inversion in needs-you: file says c > d, rows say d (700) > c (10).
      task("c", { "chat-harness": "claude-code", "chat-id": "n1" }, { updatedAt: 300 }),
      task("d", { "chat-harness": "claude-code", "chat-id": "n2" }, { updatedAt: 200 }),
    ];
    const g = deriveTodoGroups(files, [], chats);
    expect(paths(g.working)).toEqual(["tasks/b/task.md", "tasks/a/task.md"]);
    expect(paths(g.needsYou)).toEqual(["tasks/d/task.md", "tasks/c/task.md"]);
  });

  it("unresolved rows fall back to file updatedAt for recency, mixed with resolved ones", () => {
    // Both land in needs-you: one via a resolved waiting row (recency 100),
    // one via a missing row (status unknown; recency = file updatedAt 500).
    const chats = indexChats([
      chatRow("n1", "waiting", { lastEventAt: 100, updatedAt: 100 }),
    ]);
    const files = [
      task("a", { "chat-harness": "claude-code", "chat-id": "n1" }, { updatedAt: 999 }),
      task("b", { "chat-harness": "claude-code", "chat-id": "gone" }, { updatedAt: 500 }),
    ];
    const g = deriveTodoGroups(files, [], chats);
    expect(paths(g.needsYou)).toEqual(["tasks/b/task.md", "tasks/a/task.md"]);
  });

  it("omitting the index keeps today's frontmatter-only behavior", () => {
    const g = deriveTodoGroups([attached("a", "x1", "working")], []);
    expect(paths(g.working)).toEqual(["tasks/a/task.md"]);
  });
});

describe("deriveTodoGroups — populated-but-unparseable timestamps", () => {
  it("completed-at: not-a-date → still done (presence groups, parse only sorts)", () => {
    const parseable = task("ok", { "completed-at": "2026-02-01T00:00:00Z" }, { updatedAt: 1 });
    const badNew = task("bad-new", { "completed-at": "not-a-date" }, { updatedAt: 300 });
    const badOld = task("bad-old", { "completed-at": "garbage" }, { updatedAt: 200 });
    const g = deriveTodoGroups([badOld, parseable, badNew], []);
    // Unparseable rows are done but sink below parseable ones, tie-broken by
    // updatedAt desc among themselves.
    expect(paths(g.done)).toEqual([
      "tasks/ok/task.md",
      "tasks/bad-new/task.md",
      "tasks/bad-old/task.md",
    ]);
    expect(g.backlog).toHaveLength(0);
  });

  it("archived-at: garbage → still excluded from all groups and counted", () => {
    const g = deriveTodoGroups([task("a", { "archived-at": "garbage" })], []);
    expect(g.archivedCount).toBe(1);
    expect(g.backlog).toHaveLength(0);
    expect(g.done).toHaveLength(0);
  });

  it("equal completed-at ties break by updatedAt desc", () => {
    const ts = "2026-01-01T00:00:00Z";
    const old = task("old", { "completed-at": ts }, { updatedAt: 10 });
    const recent = task("recent", { "completed-at": ts }, { updatedAt: 90 });
    const g = deriveTodoGroups([old, recent], []);
    expect(paths(g.done)).toEqual(["tasks/recent/task.md", "tasks/old/task.md"]);
  });
});

describe("reorderBacklog — drag from index A to index B → next order array", () => {
  const list = ["a", "b", "c", "d"];

  it("moves a middle row up (drag c above b)", () => {
    expect(reorderBacklog(list, 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves a middle row down (drag b below c)", () => {
    expect(reorderBacklog(list, 1, 2)).toEqual(["a", "c", "b", "d"]);
  });

  it("drag to the very top", () => {
    expect(reorderBacklog(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
  });

  it("drag to the very bottom", () => {
    expect(reorderBacklog(list, 0, 3)).toEqual(["b", "c", "d", "a"]);
  });

  it("no-op drop (fromIndex === toIndex) returns the list unchanged", () => {
    expect(reorderBacklog(list, 2, 2)).toEqual(list);
  });

  it("returns a fresh copy, never mutating the input", () => {
    const input = [...list];
    const out = reorderBacklog(input, 0, 3);
    expect(input).toEqual(list); // input untouched
    expect(out).not.toBe(input);
  });

  it("out-of-range indices return the list unchanged (defensive)", () => {
    expect(reorderBacklog(list, -1, 2)).toEqual(list);
    expect(reorderBacklog(list, 1, 99)).toEqual(list);
  });

  // The write contract's whole point: the input is the FULL rendered backlog
  // (ordered rows + updatedAt-desc absentees), so the result pins every
  // currently-shown path — including an absentee that was never in the stored
  // `order`. This is what makes the setBacklogOrder write both a full replace
  // and opportunistic compaction (a stale stored path simply isn't in the input,
  // so it's dropped).
  it("dragging an absentee (below the ordered rows) pins ALL currently-shown rows", () => {
    // Simulate the rendered backlog: two manually-ordered rows, then one
    // agent-created absentee tacked on the end by sortBacklog.
    const rendered = ["ordered-1", "ordered-2", "absentee"];
    const draggedToTop = reorderBacklog(rendered, 2, 0);
    expect(draggedToTop).toEqual(["absentee", "ordered-1", "ordered-2"]);
    // Every currently-shown path is present in the write — nothing is lost, and
    // the absentee is now pinned like the rest.
    expect([...draggedToTop].sort()).toEqual([...rendered].sort());
  });

  // End-to-end with the derivation: derive the backlog, feed its paths to
  // reorderBacklog, and confirm the resulting order is a full-list replace whose
  // stored form drops a stale path that isn't shown anymore.
  it("integrates with deriveTodoGroups: writes the full shown list, dropping stale order paths", () => {
    const files: FileRow[] = [
      { path: "tasks/x/task.md", content: "---\n---\n", updatedAt: 1 },
      { path: "tasks/y/task.md", content: "---\n---\n", updatedAt: 2 },
    ];
    // `order` still references a completed/deleted task ("z") that no longer
    // shows in the backlog — a stale path.
    const order = ["tasks/x/task.md", "tasks/z/task.md", "tasks/y/task.md"];
    const g = deriveTodoGroups(files, order);
    const shown = g.backlog.map((t) => t.path);
    expect(shown).toEqual(["tasks/x/task.md", "tasks/y/task.md"]); // z pruned on read
    // Drag y above x, then persist the full shown list.
    const next = reorderBacklog(shown, 1, 0);
    expect(next).toEqual(["tasks/y/task.md", "tasks/x/task.md"]);
    // The write no longer carries the stale "z" path (compaction).
    expect(next).not.toContain("tasks/z/task.md");
  });
});

describe("prependBacklogPath — uncheck / capture-save lands a path at the top", () => {
  it("prepends a new path to the front", () => {
    expect(prependBacklogPath(["a", "b"], "new")).toEqual(["new", "a", "b"]);
  });

  it("dedups: a path already present moves to the top (no duplicate)", () => {
    expect(prependBacklogPath(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("empty order → single-element list", () => {
    expect(prependBacklogPath([], "only")).toEqual(["only"]);
  });

  it("returns a fresh array, never mutating the input", () => {
    const input = ["a", "b"];
    const out = prependBacklogPath(input, "a");
    expect(input).toEqual(["a", "b"]); // untouched
    expect(out).not.toBe(input);
    expect(out).toEqual(["a", "b"]); // 'a' de-duped back to the front
  });

  // The uncheck flow feeds the result to deriveTodoGroups' backlog partition:
  // the just-unchecked path must render at the very top of BACKLOG.
  it("integrates with deriveTodoGroups: an unchecked path renders atop BACKLOG", () => {
    const files: FileRow[] = [
      { path: "tasks/x/task.md", content: "---\n---\n", updatedAt: 1 },
      { path: "tasks/y/task.md", content: "---\n---\n", updatedAt: 2 },
    ];
    const order = ["tasks/x/task.md"];
    const next = prependBacklogPath(order, "tasks/y/task.md");
    const g = deriveTodoGroups(files, next);
    expect(g.backlog.map((t) => t.path)).toEqual([
      "tasks/y/task.md",
      "tasks/x/task.md",
    ]);
  });
});
