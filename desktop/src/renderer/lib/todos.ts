// Todos v1 derivation core (slice 1). A pure fold over the project's synced
// files into the four attention groups the todo list renders — NEEDS YOU,
// WORKING, BACKLOG, DONE — plus the archived count. No React, no Convex: it is a
// deterministic function of `files` + the backlog order list, unit-testable in
// isolation. It reuses the board's own predicates (`taskSlug`,
// `parseFrontmatter`, `parseChatRef`, `parseChatStatus`, `parseDelegationRequest`)
// so the derivation and the board agree on "what is a task" during the
// slices-2–5 coexistence window.
//
// The group model has no `status:` field (Decision 7): groups are derived from
// state the client already subscribes to. The daemon projects the ground-truth
// `chats` row into each task's frontmatter (`chat-id`/`chat-status`), so those
// keys *are* the resolved-row values the derivation keys off — no `chats` table
// input, no client-side join.

import type { ChatRef, ChatStatus, DelegationRequest } from "./chat";
import { parseChatRef, parseChatStatus, parseDelegationRequest } from "./chat";
import type { Frontmatter } from "./frontmatter";
import { parseFrontmatter } from "./frontmatter";
import { taskSlug } from "./tasks";

export type TodoGroup = "needs-you" | "working" | "backlog" | "done";

// The minimal shape the derivation needs from a Convex `files` row — a
// structural subset of what `api.files.listFiles` returns and what App.tsx feeds
// the board (`App.tsx:1651–1675` reads exactly these four fields off each row).
export interface FileRow {
  path: string;
  content: string;
  deleted?: boolean;
  updatedAt: number;
}

export interface Todo {
  path: string; // tasks/<slug>/task.md — what the dialog writes back
  slug: string;
  title: string; // frontmatter.title || slug
  content: string; // raw file text (the dialog opens on it)
  chat: ChatRef | null; // parseChatRef
  chatStatus: ChatStatus | null; // parseChatStatus
  request: DelegationRequest | null; // the pre-link summoning flag
  completedAt: number | null; // frontmatter["completed-at"], ms epoch
  archivedAt: number | null; // frontmatter["archived-at"], ms epoch
  group: TodoGroup;
  updatedAt: number; // files row updatedAt (recency proxy for chat activity)
}

export interface TodoGroups {
  needsYou: Todo[];
  working: Todo[]; // requested rows fold in here, extra-ghosted (Decision 7)
  backlog: Todo[];
  done: Todo[];
  archivedCount: number; // for the header's Archived control (App.tsx:1684 analog)
}

// COMPAT SHIM — delete in slice 6 (todos-v1 migration). Reads the legacy
// `status:` field only as a fallback so unmigrated task.md files still group
// correctly while both models coexist (slices 1→5). `done` = completed-at OR
// legacy `status: done`; `archived` = archived-at OR legacy `status: archived`;
// every other `status:` value is ignored (the task falls through to backlog).
// Kept behind this single object so slice 6 deletes it in one place.
export const legacyCompat = {
  done(fm: Frontmatter, completedAt: number | null): boolean {
    return completedAt != null || legacyStatus(fm) === "done";
  },
  archived(fm: Frontmatter, archivedAt: number | null): boolean {
    return archivedAt != null || legacyStatus(fm) === "archived";
  },
};

function legacyStatus(fm: Frontmatter): string {
  return (fm.status ?? "").trim().toLowerCase();
}

// Parse a frontmatter timestamp to ms epoch, or null when absent/unparseable.
// (Guards against Date.parse's NaN; epoch 0 is treated as a real timestamp.)
function parseTimestamp(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : t;
}

// Assign the group for one task, evaluated top-down (first match wins), per
// Decision 7's exact predicate. Archived is signalled by a null return so the
// caller can count it instead of grouping it.
function groupOf(
  fm: Frontmatter,
  todo: Omit<Todo, "group">,
): TodoGroup | null {
  // 1. archived → excluded from all groups (counted separately).
  if (legacyCompat.archived(fm, todo.archivedAt)) return null;
  // 2. completed → done (chat or not).
  if (legacyCompat.done(fm, todo.completedAt)) return "done";
  // 3. a pending/failed summon flag → working (the "Requested" fold-in; a
  //    `failed` request still lives here and renders the failed RequestChip).
  if (todo.request) return "working";
  // 4. a bound chat that is actively mid-turn → working.
  if (todo.chat && todo.chatStatus === "working") return "working";
  // 5. a bound chat that isn't working → needs-you.
  if (todo.chat) return "needs-you";
  // 6. no chat, no request, not done/archived → backlog. Any unrecognized
  //    legacy `status:` also lands here (the compat shim ignores it).
  return "backlog";
}

// True for a needs-you row that is blocked on the human (or whose launch
// failed), which sorts above plain not-working rows. (A failed *request* routes
// to WORKING via predicate 3, so that arm is effectively unreachable here; it is
// kept verbatim to match the derivation spec.)
function needsYouBlockedFirst(t: Todo): number {
  return t.chatStatus === "needs-input" || t.request?.state === "failed" ? 0 : 1;
}

const byUpdatedDesc = (a: Todo, b: Todo) => b.updatedAt - a.updatedAt;

// order = the per-project ordered task-path list (backlog manual order). May be
// stale (paths for deleted/completed/relinked tasks) or partial (agent-created
// tasks the user never touched). Both are reconciled at read time here.
export function deriveTodoGroups(files: FileRow[], order: string[]): TodoGroups {
  const todos: Todo[] = [];
  let archivedCount = 0;

  for (const f of files) {
    // Drop tombstones and any file that isn't a canonical task body — the same
    // gate the board uses (App.tsx:1653–1655).
    if (f.deleted) continue;
    const slug = taskSlug(f.path);
    if (slug === null) continue;

    const { frontmatter } = parseFrontmatter(f.content);
    const base: Omit<Todo, "group"> = {
      path: f.path,
      slug,
      title: frontmatter.title || slug,
      content: f.content,
      chat: parseChatRef(frontmatter),
      chatStatus: parseChatStatus(frontmatter),
      request: parseDelegationRequest(frontmatter),
      completedAt: parseTimestamp(frontmatter["completed-at"]),
      archivedAt: parseTimestamp(frontmatter["archived-at"]),
      updatedAt: f.updatedAt,
    };

    const group = groupOf(frontmatter, base);
    if (group === null) {
      archivedCount++;
      continue;
    }
    todos.push({ ...base, group });
  }

  const needsYou = todos
    .filter((t) => t.group === "needs-you")
    .sort(
      (a, b) =>
        needsYouBlockedFirst(a) - needsYouBlockedFirst(b) ||
        b.updatedAt - a.updatedAt,
    );

  const working = todos.filter((t) => t.group === "working").sort(byUpdatedDesc);

  const done = todos
    .filter((t) => t.group === "done")
    // completedAt is non-null for every done row (predicate 2 / compat shim);
    // fall back to 0 defensively so the sort never sees NaN.
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));

  const backlog = sortBacklog(
    todos.filter((t) => t.group === "backlog"),
    order,
  );

  return { needsYou, working, backlog, done, archivedCount };
}

// Backlog manual order: stable-partition into (a) paths present in `order`, kept
// in `order`'s sequence (stale paths in `order` are ignored), then (b) absentees
// — tasks not in `order`, e.g. agent-created — appended by updatedAt desc.
// `order` can legally contain duplicate paths (uncheck prepends without pruning
// the stored array), so each todo is emitted once, at its first occurrence.
function sortBacklog(backlog: Todo[], order: string[]): Todo[] {
  const byPath = new Map(backlog.map((t) => [t.path, t]));
  const inOrder = new Set(order);

  const ordered: Todo[] = [];
  for (const path of order) {
    const todo = byPath.get(path);
    if (todo) {
      ordered.push(todo); // stale paths absent from the backlog are dropped
      byPath.delete(path); // dedupe: later occurrences of this path are no-ops
    }
  }
  const absentees = backlog
    .filter((t) => !inOrder.has(t.path))
    .sort(byUpdatedDesc);

  return ordered.concat(absentees);
}
