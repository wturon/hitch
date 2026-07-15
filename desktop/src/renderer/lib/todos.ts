// Todos v1 derivation core (slice 1). A pure fold over the project's synced
// files into the four attention groups the todo list renders — NEEDS YOU,
// WORKING, BACKLOG, DONE — plus the archived count. No React, no Convex: it is a
// deterministic function of `files` + the backlog order list + (optionally) an
// index of live chat rows, unit-testable in isolation. It reuses the board's own
// predicates (`taskSlug`, `parseFrontmatter`, `parseChatRef`, `parseChatStatus`,
// `parseDelegationRequest`) so the derivation and the board agree on "what is a
// task" during the slices-2–5 coexistence window.
//
// The group model has no `status:` field (Decision 7): groups are derived from
// state the client already subscribes to. All chat state flows through one seam,
// `resolveChatState`: *attachment* is frontmatter-driven (`chat-id`), while
// *status* and *recency* prefer the resolved live `chats` row when the caller
// supplies the index, falling back to the daemon-projected frontmatter
// (`chat-status`) / file recency otherwise — so calling without `chats` matches
// today's read path exactly.

// Imports come from ./chatModel (not ./chat) so this module's whole import
// chain stays pure — no DOM, no React — which lets the Convex sidebar-badge
// query (convex/files.ts) import this file directly and share the exact
// predicate instead of maintaining a server-side twin. ./chat re-exports the
// same names, so semantics are identical for renderer consumers.
import type { ChatRef, ChatStatus, DelegationRequest, Harness } from "./chatModel";
import {
  normalizeChatStatus,
  parseChatRef,
  parseChatStatus,
  parseDelegationRequest,
} from "./chatModel";
import type { Frontmatter } from "./frontmatter";
import { parseFrontmatter, parseTagsValue } from "./frontmatter";
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
  // Convex stamps `_creationTime` on every document and `listFiles` returns rows
  // verbatim (.collect()), so it's already on the client — we just type it here.
  // It's the task's fixed birth time, used as the stable attention-group sort key
  // (see byCreatedDesc). Optional so plain FileRow fixtures/tests can omit it.
  _creationTime?: number;
}

// The minimal shape the derivation needs from a live `chats` row — a structural
// subset of the raw Convex row (which this module can't import without dragging
// in the generated Convex api). `status` is the stored union (which includes
// "idle"); it's normalized on read.
export interface LiveChatRow {
  harness: Harness;
  chatId?: string;
  status: string;
  lastEventAt: number;
  updatedAt: number;
}

// Index key for a live chat row: harness + harness-native chat id — the same
// pair `parseChatRef` reads from frontmatter and the daemon's observer keys by
// (daemon/src/observer/index.ts: `${harness}:${chatId}`). Host is deliberately
// not part of the key: frontmatter carries no host, and one todo binds one chat.
export function chatKey(harness: Harness, chatId: string): string {
  return `${harness}:${chatId}`;
}

// Build the chat index from any live-row collection (pass non-deleted rows).
// Rows still pending (no harness-native chatId yet) can't be referenced by
// frontmatter, so they are skipped.
export function indexChats(
  rows: Iterable<LiveChatRow>,
): Map<string, LiveChatRow> {
  const index = new Map<string, LiveChatRow>();
  for (const row of rows) {
    if (row.chatId) index.set(chatKey(row.harness, row.chatId), row);
  }
  return index;
}

export interface Todo {
  path: string; // tasks/<slug>/task.md — what the dialog writes back
  slug: string;
  title: string; // frontmatter.title || slug
  content: string; // raw file text (the dialog opens on it)
  chat: ChatRef | null; // parseChatRef (attachment is frontmatter-driven)
  chatStatus: ChatStatus | null; // live row preferred, frontmatter fallback
  chatRecency: number | null; // live row recency; null when no row resolved
  request: DelegationRequest | null; // the pre-link summoning flag
  // Parsed `completed-at`/`archived-at` SORT KEYS — null when the raw value is
  // absent OR unparseable. Presence (which decides the group) is checked on the
  // raw frontmatter value, never on these.
  completedAt: number | null;
  archivedAt: number | null;
  group: TodoGroup;
  tags: string[]; // parsed from frontmatter `tags:` (normalized, deduped)
  updatedAt: number; // files row updatedAt
  createdAt: number; // files row _creationTime (fixed); stable sort key
}

export interface TodoGroups {
  needsYou: Todo[];
  working: Todo[]; // requested rows fold in here, extra-ghosted (Decision 7)
  backlog: Todo[];
  done: Todo[];
  archivedCount: number; // for the header's Archived control (App.tsx:1684 analog)
}

// A frontmatter timestamp field is "populated" when it holds any non-empty
// value. Population is what the group predicates key off (Decision 7: agent
// frontmatter edits are honored, even a malformed date); parsing below only
// supplies the sort key.
function timestampPresent(raw: string | undefined): boolean {
  return (raw ?? "").trim() !== "";
}

// Parse a frontmatter timestamp to a ms-epoch sort key, or null when
// absent/unparseable. (Guards against Date.parse's NaN; epoch 0 is real.)
function parseTimestamp(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? null : t;
}

interface ResolvedChatState {
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
  chatRecency: number | null;
}

// THE chat-state seam. Attachment stays frontmatter-driven on purpose: a
// `chat-id` whose live row is missing/deleted must still read as attached, so
// the todo parks in NEEDS YOU until the user detaches it deliberately —
// resolution failure never silently un-attaches a todo (and the pre-bind
// `chat-request` flag stays pure frontmatter by the same logic).
//
// Status/recency have two explicit modes:
// - `chats` NOT supplied (frontmatter-only coexistence mode): status falls back
//   to the daemon-projected `chat-status`, recency to the file's own updatedAt —
//   today's read path, unchanged.
// - `chats` supplied: the live row is authoritative. Row resolves → its
//   status/recency win over any projected frontmatter. Row missing → status is
//   unknown (null, i.e. not-working → NEEDS YOU); the stale projected
//   `chat-status` is deliberately NOT read in this branch, so a dead chat can't
//   strand the todo in WORKING on a leftover `chat-status: working`.
function resolveChatState(
  fm: Frontmatter,
  chats?: ReadonlyMap<string, LiveChatRow>,
): ResolvedChatState {
  const chat = parseChatRef(fm);
  if (!chat || !chats) {
    return { chat, chatStatus: parseChatStatus(fm), chatRecency: null };
  }
  const row = chats.get(chatKey(chat.harness, chat.id));
  if (!row) {
    return { chat, chatStatus: null, chatRecency: null };
  }
  return {
    chat,
    // The stored union includes "idle"; normalizeChatStatus maps it (and any
    // other alias) into the client ChatStatus — idle reads as not-working.
    chatStatus: normalizeChatStatus(row.status),
    // The freshest of event vs row write.
    chatRecency: Math.max(row.lastEventAt, row.updatedAt),
  };
}

// Assign the group for one task, evaluated top-down (first match wins), per
// Decision 7's exact predicate. Archived is signalled by a null return so the
// caller can count it instead of grouping it. Presence booleans — not parsed
// timestamps — drive predicates 1–2.
function groupOf(args: {
  archivedPresent: boolean;
  completedPresent: boolean;
  request: DelegationRequest | null;
  chat: ChatRef | null;
  chatStatus: ChatStatus | null;
}): TodoGroup | null {
  // 1. archived → excluded from all groups (counted separately).
  if (args.archivedPresent) return null;
  // 2. completed → done (chat or not).
  if (args.completedPresent) return "done";
  // 3. a pending/failed summon flag → working (the "Requested" fold-in; a
  //    `failed` request still lives here and renders the failed RequestChip).
  if (args.request) return "working";
  // 4. a bound chat that is actively mid-turn → working.
  if (args.chat && args.chatStatus === "working") return "working";
  // 5. a bound chat that isn't working → needs-you.
  if (args.chat) return "needs-you";
  // 6. no chat, no request, not done/archived → backlog.
  return "backlog";
}

// True for a needs-you row that is blocked on the human (or whose launch
// failed), which sorts above plain not-working rows. (A failed *request* routes
// to WORKING via predicate 3, so that arm is effectively unreachable here; it is
// kept verbatim to match the derivation spec.)
function needsYouBlockedFirst(t: Todo): number {
  return t.chatStatus === "needs-input" || t.request?.state === "failed" ? 0 : 1;
}

// The stable ordering key for the two chat-driven attention groups (NEEDS YOU,
// WORKING). We deliberately do NOT sort by live chat recency here: that value
// ticks on every chat event, so rows reordered under the cursor while you aimed
// at one (the scanning-instability the critique flagged). Creation time is fixed
// for a task's lifetime, so the order is deterministic and never jumps — no
// frozen-order wrapper needed. Newest first; path breaks ties for a total order.
// (chatRecency still drives the NEEDS YOU "last activity" subtitle, just not the
// sort.)
const byCreatedDesc = (a: Todo, b: Todo) =>
  b.createdAt - a.createdAt ||
  (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// order = the per-project ordered task-path list (backlog manual order). May be
// stale (paths for deleted/completed/relinked tasks) or partial (agent-created
// tasks the user never touched). Both are reconciled at read time here.
// chats = optional live-chat index (see indexChats); omitted → frontmatter-only,
// which keeps the function's output a pure fold over `files` + `order`.
export function deriveTodoGroups(
  files: FileRow[],
  order: string[],
  chats?: ReadonlyMap<string, LiveChatRow>,
): TodoGroups {
  const todos: Todo[] = [];
  let archivedCount = 0;

  for (const f of files) {
    // Drop tombstones and any file that isn't a canonical task body — the same
    // gate the board uses (App.tsx:1653–1655).
    if (f.deleted) continue;
    const slug = taskSlug(f.path);
    if (slug === null) continue;

    const { frontmatter } = parseFrontmatter(f.content);
    const { chat, chatStatus, chatRecency } = resolveChatState(
      frontmatter,
      chats,
    );
    const request = parseDelegationRequest(frontmatter);
    const completedPresent = timestampPresent(frontmatter["completed-at"]);
    const archivedPresent = timestampPresent(frontmatter["archived-at"]);

    const group = groupOf({
      archivedPresent,
      completedPresent,
      request,
      chat,
      chatStatus,
    });
    if (group === null) {
      archivedCount++;
      continue;
    }
    todos.push({
      path: f.path,
      slug,
      title: frontmatter.title || slug,
      content: f.content,
      chat,
      chatStatus,
      chatRecency,
      request,
      completedAt: parseTimestamp(frontmatter["completed-at"]),
      archivedAt: parseTimestamp(frontmatter["archived-at"]),
      group,
      tags: parseTagsValue(frontmatter.tags),
      updatedAt: f.updatedAt,
      createdAt: f._creationTime ?? f.updatedAt,
    });
  }

  const needsYou = todos
    .filter((t) => t.group === "needs-you")
    .sort(
      (a, b) =>
        needsYouBlockedFirst(a) - needsYouBlockedFirst(b) ||
        byCreatedDesc(a, b),
    );

  const working = todos.filter((t) => t.group === "working").sort(byCreatedDesc);

  const done = todos
    .filter((t) => t.group === "done")
    // Sort key first; rows with an absent/unparseable `completed-at` (or legacy
    // `status: done`) fall to the bottom and tie-break by updatedAt desc, which
    // also deterministically breaks exact completed-at ties.
    .sort(
      (a, b) =>
        (b.completedAt ?? 0) - (a.completedAt ?? 0) ||
        b.updatedAt - a.updatedAt,
    );

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
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return ordered.concat(absentees);
}

// Compute the next full ordered array of task-paths to persist via
// `setBacklogOrder` after the user drags a backlog row from `fromIndex` to
// `toIndex`. The input MUST be the *currently-shown* backlog paths in their
// rendered order — i.e. `deriveTodoGroups(...).backlog.map(t => t.path)`, which
// already interleaves `order`-listed rows with the updatedAt-desc absentee block
// (sortBacklog). Because the input is that full rendered list, the returned
// array pins EVERY currently-shown row — ordered rows and absentees alike — so:
//   • it's the whole-list replace the write contract wants (setBacklogOrder is a
//     dumb replace, no server-side merge);
//   • stale paths in the old stored `order` (deleted/completed/relinked tasks)
//     are simply never included → opportunistic compaction happens for free, the
//     stored array can't grow unbounded with tombstones;
//   • dragging an absentee (an agent-created task the user never touched) lands
//     it pinned like any other row, and pins the rest of the list with it.
// A no-op drop or out-of-range index returns the list unchanged (a fresh copy).
export function reorderBacklog(
  paths: string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const next = paths.slice();
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= next.length ||
    toIndex >= next.length
  ) {
    return next;
  }
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

// Prepend a task path to the front of the manual backlog order, deduping any
// existing occurrence so the path lands exactly once at the top (Decision 8's
// "uncheck returns the todo to the top of Backlog", and the capture-save
// prepend). Pure so the uncheck/prepend arithmetic is unit-testable without the
// mutation. The caller persists the result via `setBacklogOrder`.
export function prependBacklogPath(order: string[], path: string): string[] {
  return [path, ...order.filter((p) => p !== path)];
}

// The sidebar-badge projection of the group predicate: the counted attention
// group for ONE task body's raw content — "working" / "needs-you" / null
// (done, archived, or backlog: uncounted). This is the same predicate chain
// deriveTodoGroups runs per file (parseFrontmatter → resolveChatState →
// groupOf), just without the UI fields or sorting, exported so the Convex
// badge query (convex/files.ts chatStatusCounts) counts with the identical
// semantics — including the two-mode chat resolution: pass the live-chat
// index and a frontmatter `chat-id` whose row is missing/idle reads as
// not-working → needs-you, exactly like the list.
export type CountedTodoGroup = "working" | "needs-you";

export function taskCountedGroup(
  content: string,
  chats?: ReadonlyMap<string, LiveChatRow>,
): CountedTodoGroup | null {
  const { frontmatter } = parseFrontmatter(content);
  const { chat, chatStatus } = resolveChatState(frontmatter, chats);
  const group = groupOf({
    archivedPresent: timestampPresent(frontmatter["archived-at"]),
    completedPresent: timestampPresent(frontmatter["completed-at"]),
    request: parseDelegationRequest(frontmatter),
    chat,
    chatStatus,
  });
  return group === "working" || group === "needs-you" ? group : null;
}

// --- Tag filtering (view-local, AND semantics) ------------------------------
//
// The filter is applied AFTER derivation, over the already-grouped rows, so the
// grouping/sorting stays a pure function of files + order + chats and the filter
// is a cheap projection on top (persisted per project in localStorage, never in
// Convex or files). AND semantics: a row matches only if it carries EVERY
// selected tag. `untagged` is exclusive — it matches rows with zero tags and can
// never co-exist with tag selections (untagged ∧ tag is always empty).

export interface TagFilter {
  tags: string[]; // AND-selected tag ids
  untagged: boolean; // exclusive with `tags`
}

export const EMPTY_TAG_FILTER: TagFilter = { tags: [], untagged: false };

export function isTagFilterActive(f: TagFilter): boolean {
  return f.untagged || f.tags.length > 0;
}

export function todoMatchesTagFilter(todo: Todo, f: TagFilter): boolean {
  if (f.untagged) return todo.tags.length === 0;
  if (f.tags.length === 0) return true;
  return f.tags.every((t) => todo.tags.includes(t));
}

// Project the grouped rows through the active filter. Inactive filter → the
// groups pass through unchanged (same object). Non-matching rows drop out, which
// naturally empties groups the view then hides entirely; `archivedCount` is
// untouched (the sidebar/archived count ignores the filter).
export function filterTodoGroups(groups: TodoGroups, f: TagFilter): TodoGroups {
  if (!isTagFilterActive(f)) return groups;
  const keep = (list: Todo[]) =>
    list.filter((t) => todoMatchesTagFilter(t, f));
  return {
    needsYou: keep(groups.needsYou),
    working: keep(groups.working),
    backlog: keep(groups.backlog),
    done: keep(groups.done),
    archivedCount: groups.archivedCount,
  };
}

// The flat, non-archived universe the filter and facet counts operate over.
export function allGroupTodos(groups: TodoGroups): Todo[] {
  return [
    ...groups.needsYou,
    ...groups.working,
    ...groups.backlog,
    ...groups.done,
  ];
}

// Facet counts for the filter popover. For each tag: how many tasks WOULD match
// if that tag were added to the current selection (checked tags show the current
// match count, since re-adding an already-selected tag is a no-op). `untagged`
// is the count of tasks with zero tags (what selecting Untagged would show,
// since it clears all tag selections). A registry tag absent from `todos` isn't
// in `byTag` — callers default it to 0 (adding an unused tag to an AND filter
// yields nothing). When the filter is currently on Untagged, counts are computed
// against a cleared base so the tag rows preview "switch to this tag".
export function tagFacetCounts(
  todos: Todo[],
  f: TagFilter,
): { byTag: Map<string, number>; untagged: number } {
  const base: TagFilter = f.untagged ? EMPTY_TAG_FILTER : f;
  const byTag = new Map<string, number>();
  const universe = new Set<string>();
  for (const t of todos) for (const tag of t.tags) universe.add(tag);
  for (const tag of universe) {
    const probe: TagFilter = base.tags.includes(tag)
      ? base
      : { tags: [...base.tags, tag], untagged: false };
    byTag.set(tag, todos.filter((t) => todoMatchesTagFilter(t, probe)).length);
  }
  return {
    byTag,
    untagged: todos.filter((t) => t.tags.length === 0).length,
  };
}
