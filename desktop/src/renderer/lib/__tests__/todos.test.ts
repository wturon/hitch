import { describe, expect, it } from "vitest";

import { deriveTodoGroups, type FileRow } from "../todos";

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

describe("deriveTodoGroups — compat shim (legacy status:)", () => {
  it("status: done → done", () => {
    const g = deriveTodoGroups([task("a", { status: "done" })], []);
    expect(paths(g.done)).toEqual(["tasks/a/task.md"]);
  });

  it("status: archived → archived (excluded + counted)", () => {
    const g = deriveTodoGroups([task("a", { status: "archived" })], []);
    expect(g.archivedCount).toBe(1);
    expect(g.backlog).toHaveLength(0);
  });

  it("status: <unknown> is ignored → backlog", () => {
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

  it("case-insensitive legacy status (DONE / Archived)", () => {
    const g = deriveTodoGroups(
      [task("a", { status: "DONE" }), task("b", { status: "Archived" })],
      [],
    );
    expect(paths(g.done)).toEqual(["tasks/a/task.md"]);
    expect(g.archivedCount).toBe(1);
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
