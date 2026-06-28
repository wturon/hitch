"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  AlignLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronLeftIcon,
  CodeIcon,
  CopyIcon,
  EllipsisIcon,
  LoaderCircle,
  MessageSquareIcon,
  PaperclipIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import {
  parseFrontmatter,
  setFrontmatterKeys,
  splitFrontmatter,
} from "@/lib/frontmatter";
import { noteBodyPath, noteSlug } from "@/lib/notes";
import { uniqueSlug } from "@/lib/tasks";
import { useFrontmatterDocument } from "@/hooks/useFrontmatterDocument";
import { useAttachments } from "@/hooks/useAttachments";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/MarkdownEditor";
import { ChatComposer, ChatRow } from "@/components/ChatsView";
import { useChatActions, useChatsHome } from "@/hooks/useChats";
import type { ChatRowViewModel } from "@/lib/chats";
import type { Harness } from "@/lib/chat";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// A note is a folder under notes/, its body in index.md. This is the in-memory
// model the index renders, mirroring the board's Card. `content` is the raw
// file text (frontmatter + body) the editor writes back verbatim.
interface NoteDoc {
  slug: string;
  title: string;
  type: string;
  path: string; // notes/<slug>/index.md
  content: string;
  archived: boolean;
  updatedAt: number;
}

// The freeform OKF type field, required with a "note" default — no untyped docs.
const DEFAULT_TYPE = "note";

// A one-shot request from the global command palette to open an existing note or
// create one. Routed through NotesView (rather than lifting `selectedSlug` out)
// so `openDoc`/`createNote` keep their synchronous flush-before-switch — the only
// moment an outgoing draft can be saved before the keyed editor remounts.
export type NoteIntent =
  | { type: "open"; slug: string }
  | { type: "create"; title: string };

interface FileDoc {
  _id: Id<"files">;
  path: string;
  content: string;
  deleted: boolean;
  updatedAt: number;
}

function docType(type: string | undefined): string {
  const t = (type ?? "").trim();
  return t || DEFAULT_TYPE;
}

// Build the doc list from the project's files: keep only canonical index.md
// bodies, parse frontmatter, drop tombstones. Exported so the workspace header
// can count archived notes for its top-right Archived control.
export function noteDocs(files: FileDoc[]): NoteDoc[] {
  return files.reduce<NoteDoc[]>((acc, f) => {
    if (f.deleted) return acc;
    const slug = noteSlug(f.path);
    if (slug === null) return acc;
    const { frontmatter } = parseFrontmatter(f.content);
    acc.push({
      slug,
      title: frontmatter.title || slug,
      type: docType(frontmatter.type),
      path: f.path,
      content: f.content,
      archived: frontmatter.archived === "true",
      updatedAt: f.updatedAt,
    });
    return acc;
  }, []);
}

export function NotesView({
  projectId,
  files,
  showArchived,
  onShowArchivedChange,
  onExit,
  intent,
  onIntentHandled,
}: {
  projectId: Id<"projects">;
  files: FileDoc[];
  // The Archived sheet is opened from the shared workspace header (top-right),
  // so its open state is owned by the parent and threaded back in here.
  showArchived: boolean;
  onShowArchivedChange: (open: boolean) => void;
  // Esc on the index (with no query) leaves Notes for the Board — the parent owns
  // the Board/Notes tab.
  onExit: () => void;
  // Open/create request from the command palette, consumed once then acked.
  intent: NoteIntent | null;
  onIntentHandled: () => void;
}) {
  // Same optimistic upsert the board uses: a create/rename/archive reflects
  // instantly instead of waiting on the frontmatter → daemon → Convex round trip.
  const upsertFile = useMutation(api.files.upsertFile).withOptimisticUpdate(
    (localStore, args) => {
      const existing = localStore.getQuery(api.files.listFiles, {
        projectId: args.projectId,
      });
      if (existing === undefined) return;
      type Doc = (typeof existing)[number];
      const idx = existing.findIndex((f) => f.path === args.path);
      const base: Doc =
        idx >= 0
          ? existing[idx]
          : ({
              _id: `optimistic:${args.path}` as Doc["_id"],
              _creationTime: Number.MAX_SAFE_INTEGER,
              projectId: "" as Doc["projectId"],
              path: args.path,
              content: "",
              hash: "",
              deleted: false,
              updatedAt: Number.MAX_SAFE_INTEGER,
            } satisfies Doc);
      const patched: Doc = {
        ...base,
        content: args.content,
        hash: args.hash,
        deleted: args.deleted,
        updatedAt: Number.MAX_SAFE_INTEGER,
      };
      const next =
        idx >= 0
          ? existing.map((f, i) => (i === idx ? patched : f))
          : [...existing, patched];
      localStore.setQuery(api.files.listFiles, { projectId: args.projectId }, next);
    },
  );
  const registerAttachment = useMutation(api.attachments.registerAttachment);
  const tombstoneAttachment = useMutation(api.attachments.tombstoneAttachment);
  const attachments = useQuery(api.attachments.listAttachments, { projectId });

  // The project's active chats (same query the Chats tab home uses). The open
  // note's linked chat is resolved from here by linkedType/linkedPath, and the
  // foot's resume/pin/archive/delete reuse the exact Chats-tab actions.
  const chatsHome = useChatsHome(projectId);
  const chatActions = useChatActions();

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  // The open editor registers its draft-flush here; we call it before swapping
  // the selection or on unmount (tab/project switch). It resets to a no-op when
  // no editor is mounted, so it never re-saves a note we've already left.
  const flushRef = useRef<() => void>(() => {});

  // Flush the open doc on a real unmount (the tab or project changed). Safe under
  // StrictMode's mount→unmount→mount: at first mount nothing is selected, so the
  // ref is still the no-op default.
  useEffect(() => () => flushRef.current(), []);

  const docs = useMemo(() => noteDocs(files), [files]);
  const archivedDocs = useMemo(() => docs.filter((d) => d.archived), [docs]);
  // The index lists active notes most-recently-edited first (recency, no type
  // grouping). A freshly created/edited note carries an optimistic updatedAt of
  // MAX_SAFE_INTEGER, so it surfaces at the top immediately.
  const recentDocs = useMemo(
    () =>
      docs
        .filter((d) => !d.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [docs],
  );
  const selected = selectedSlug
    ? (docs.find((d) => d.slug === selectedSlug && !d.archived) ?? null)
    : null;

  // The open note's linked chat, if any: the newest active (non-archived,
  // non-deleted) chat whose link points back at this note. One chat per note —
  // archiving/deleting it (or having none) drops the foot back to the launcher.
  // listHome already excludes archived/deleted; the guards are belt-and-braces.
  const linkedChat = useMemo(() => {
    if (!selected) return null;
    const home = chatsHome.data;
    if (!home) return null;
    return (
      [...home.pinned, ...home.recent]
        .filter(
          (c) =>
            !c.archived &&
            !c.deleted &&
            c.linkedType === "note" &&
            c.linkedPath === selected.path,
        )
        .sort((a, b) => b.sortTime - a.sortTime)[0] ?? null
    );
  }, [chatsHome.data, selected]);

  // Start a note-linked chat from the foot composer: same startChat the Chats
  // tab and TaskDialog use, with linkedType "note" and the note's index.md path.
  // No title (default naming) and no cwd (the daemon resolves the project cwd).
  async function startNoteChat(
    note: NoteDoc,
    params: { harness: Harness; model: string; effort: string; prompt: string },
  ) {
    await chatActions.startChat({
      projectId,
      harness: params.harness,
      initialPrompt: params.prompt,
      model: params.model,
      effort: params.effort,
      linkedType: "note",
      linkedPath: note.path,
    });
  }

  // Resume/pin/archive/delete for the foot's ChatRow — identical to the Chats
  // tab's row handlers, so a note's docked chat behaves exactly like one there.
  const chatRowHandlers = useMemo(
    () => ({
      onResume: (chat: ChatRowViewModel) =>
        void Promise.resolve(
          chatActions.resumeChat({ projectId, id: chat.id }),
        ).catch(() => {}),
      onPin: (chat: ChatRowViewModel) =>
        void chatActions.pinChat({ projectId, id: chat.id }),
      onUnpin: (chat: ChatRowViewModel) =>
        void chatActions.unpinChat({ projectId, id: chat.id }),
      onArchive: (chat: ChatRowViewModel) =>
        void chatActions.archiveChat({ projectId, id: chat.id }),
      onUnarchive: (chat: ChatRowViewModel) =>
        void chatActions.unarchiveChat({ projectId, id: chat.id }),
      onDelete: (chat: ChatRowViewModel) =>
        void chatActions.deleteChat({ projectId, id: chat.id }),
    }),
    [chatActions, projectId],
  );

  // If the open note disappears from the active list (archived or deleted, here
  // or remotely), fall back to the index rather than a dangling editor.
  useEffect(() => {
    if (selectedSlug === null) return;
    if (!recentDocs.some((d) => d.slug === selectedSlug)) setSelectedSlug(null);
  }, [recentDocs, selectedSlug]);

  async function persist(path: string, content: string) {
    await upsertFile({
      projectId,
      path,
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  // Tombstone every (non-deleted) attachment row under a doc's folder so the
  // daemon removes the local blobs and the now-empty folders. Mirrors the board.
  async function cascadeDeleteAttachments(slug: string) {
    const prefix = `notes/${slug}/attachments/`;
    const rows = (attachments ?? []).filter(
      (row) => !row.deleted && row.path.startsWith(prefix),
    );
    await Promise.all(
      rows.map((row) => tombstoneAttachment({ projectId, path: row.path })),
    );
  }

  // Move every attachment row from one slug's folder to another, preserving the
  // blob (same storageId) — used when a rename recomputes the folder name. The
  // body's `attachments/<file>` references are relative, so they stay valid.
  async function migrateAttachments(oldSlug: string, newSlug: string) {
    const prefix = `notes/${oldSlug}/attachments/`;
    const rows = (attachments ?? []).filter(
      (row) => !row.deleted && row.path.startsWith(prefix),
    );
    for (const row of rows) {
      const name = row.path.slice(prefix.length);
      await registerAttachment({
        projectId,
        path: `notes/${newSlug}/attachments/${name}`,
        storageId: row.storageId,
        hash: row.hash,
        contentType: row.contentType,
        size: row.size,
      });
      await tombstoneAttachment({ projectId, path: row.path });
    }
  }

  // Create a note from the index (title pre-filled, or blank for "New note") and
  // open it. The slug is derived from the title (uniqued); the editor lands the
  // cursor in the body when the title is set, else in the title. An empty doc is
  // discarded on flush, so an abandoned create leaves nothing behind.
  //
  // Order matters: fire the optimistic write, THEN select — both land in the same
  // render, so `docs` already contains the note when it's selected. Selecting
  // first would briefly leave `selectedSlug` pointing at a note not yet in the
  // list, and the fall-back-to-index effect would clear it before it arrived.
  async function createNote(title: string) {
    // Save any open draft before swapping to the new note — a no-op from the
    // index (no editor mounted), but the palette can create while an editor is
    // open, and the outgoing draft must not be lost.
    flushRef.current();
    const taken = new Set(docs.map((d) => d.slug));
    const slug = uniqueSlug(title, taken, DEFAULT_TYPE);
    const content = setFrontmatterKeys("", {
      title: title || undefined,
      type: DEFAULT_TYPE,
      created: new Date().toISOString(),
    });
    const hash = await sha256(content);
    void upsertFile({
      projectId,
      path: noteBodyPath(slug),
      content,
      hash,
      deleted: false,
    });
    setSelectedSlug(slug);
  }

  // In-place save (⌘S and the type pill): write the draft at its current path,
  // never recomputing the slug. Slug reconciliation is deferred to flush so the
  // folder doesn't churn mid-edit.
  async function saveDoc(slug: string, content: string) {
    await persist(noteBodyPath(slug), content);
  }

  // The deferred "explicit save" that also reconciles the slug — called when the
  // editor closes (Esc / back) or unmounts (tab/project switch). Discards an
  // empty doc; renames the folder when the title's slug has drifted (write new
  // path + migrate attachments + tombstone old).
  async function flushDoc(slug: string, content: string) {
    const { frontmatter } = parseFrontmatter(content);
    const { body } = splitFrontmatter(content);
    const title = frontmatter.title ?? "";
    if (!title.trim() && !body.trim()) {
      await deleteDoc(slug);
      return;
    }
    const taken = new Set(docs.map((d) => d.slug).filter((s) => s !== slug));
    const newSlug = uniqueSlug(title, taken, DEFAULT_TYPE);
    if (newSlug === slug) {
      const current = files.find(
        (f) => f.path === noteBodyPath(slug) && !f.deleted,
      );
      if (current?.content === content) return; // nothing changed
      await persist(noteBodyPath(slug), content);
      return;
    }
    await persist(noteBodyPath(newSlug), content);
    await migrateAttachments(slug, newSlug);
    await upsertFile({
      projectId,
      path: noteBodyPath(slug),
      content: "",
      hash: "",
      deleted: true,
    });
  }

  async function setArchived(doc: NoteDoc, archived: boolean) {
    const next = setFrontmatterKeys(doc.content, {
      archived: archived ? "true" : undefined,
    });
    setPendingSlug(doc.slug);
    try {
      await persist(doc.path, next);
    } finally {
      setPendingSlug(null);
    }
  }

  async function deleteDoc(slug: string) {
    setPendingSlug(slug);
    try {
      await cascadeDeleteAttachments(slug);
      await upsertFile({
        projectId,
        path: noteBodyPath(slug),
        content: "",
        hash: "",
        deleted: true,
      });
    } finally {
      setPendingSlug(null);
    }
  }

  // Open a note from the index. Flushing the (possibly) outgoing draft first is a
  // no-op in practice — the index is only interactive when no editor is mounted —
  // but it's harmless and keeps the invariant explicit.
  function openDoc(slug: string) {
    if (slug === selectedSlug) return;
    flushRef.current();
    setSelectedSlug(slug);
  }

  // Consume a one-shot palette request. openDoc/createNote both flush the
  // outgoing draft first (see their bodies), so switching notes mid-edit is
  // safe. Ack so the parent clears `intent` and a later identical request still
  // re-fires.
  useEffect(() => {
    if (!intent) return;
    if (intent.type === "open") openDoc(intent.slug);
    else void createNote(intent.title);
    onIntentHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  return (
    <div className="-mx-4 flex min-h-0 flex-1 flex-col sm:-mx-6 lg:-mx-8">
      {/* The index stays mounted while a note is open (just hidden) so its search
          query, keyboard selection, and scroll position are exactly restored when
          you Esc back. */}
      <NotesIndex
        docs={recentDocs}
        active={selected === null}
        pendingSlug={pendingSlug}
        onOpen={openDoc}
        onCreate={(title) => void createNote(title)}
        onArchive={(doc) => void setArchived(doc, true)}
        onDelete={(doc) => void deleteDoc(doc.slug)}
        onExit={onExit}
      />

      {selected && (
        <NoteEditor
          key={selected.slug}
          projectId={projectId}
          slug={selected.slug}
          content={selected.content}
          linkedChat={linkedChat}
          chatRowHandlers={chatRowHandlers}
          onStartChat={(params) => startNoteChat(selected, params)}
          onSave={saveDoc}
          onFlush={flushDoc}
          registerFlush={(fn) => {
            flushRef.current = fn;
          }}
          onArchive={(slug, content) =>
            void persist(
              noteBodyPath(slug),
              setFrontmatterKeys(content, { archived: "true" }),
            )
          }
          onDelete={(slug) => void deleteDoc(slug)}
          onClose={() => setSelectedSlug(null)}
        />
      )}

      <NotesArchivedSheet
        open={showArchived}
        onOpenChange={onShowArchivedChange}
        docs={archivedDocs}
        pendingSlug={pendingSlug}
        onUnarchive={(doc) => void setArchived(doc, false)}
        onDelete={(doc) => void deleteDoc(doc.slug)}
      />
    </div>
  );
}

// Relative "last edited" stamp for the index rows. Optimistic writes carry a
// future timestamp (MAX_SAFE_INTEGER) → a negative diff → "now", which is what
// we want for a note you just touched.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  const week = 7 * day;
  if (diff < min) return "now";
  if (diff < hour) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  if (diff < 2 * day) return "Yesterday";
  if (diff < week) return `${Math.floor(diff / day)}d`;
  if (diff < 4 * week) return `${Math.floor(diff / week)}w`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function copyNotePath(slug: string) {
  // Project-root-relative path (includes .hitch/) — the reading agent's cwd is
  // the project root, so this pastes straight into a live chat.
  void navigator.clipboard.writeText(`.hitch/${noteBodyPath(slug)}`).catch(() => {});
}

// The first non-empty body line, lightly de-marked, for an index row's preview.
function notePreview(content: string): string {
  const { body } = splitFrontmatter(content);
  for (const line of body.split(/\r?\n/)) {
    const stripped = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^>\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/[*_`]/g, "")
      .trim();
    if (stripped) return stripped;
  }
  return "";
}

// Rank notes against a query: title prefix > title substring > preview > type.
// Ties break on recency. Empty query returns the list unchanged (recency order).
function rankNotes(docs: NoteDoc[], query: string): NoteDoc[] {
  const q = query.trim().toLowerCase();
  if (!q) return docs;
  const scored: { doc: NoteDoc; score: number }[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 3;
    else if (title.includes(q)) score = 2;
    else if (notePreview(doc.content).toLowerCase().includes(q)) score = 1;
    else if (doc.type.toLowerCase().includes(q)) score = 0;
    if (score >= 0) scored.push({ doc, score });
  }
  scored.sort((a, b) => b.score - a.score || b.doc.updatedAt - a.doc.updatedAt);
  return scored.map((s) => s.doc);
}

type IndexItem =
  | { kind: "note"; doc: NoteDoc }
  | { kind: "create"; title: string };

// The Notes landing page: a search-led, keyboard-driven command list (Raycast
// style). Empty query → recency list. Typing → ranked results with a "Create
// <query>" row pinned last. ↑↓ move the selection, ↵ opens/creates, Esc clears
// the query. Stays mounted (hidden) while a note is open so state is preserved.
function NotesIndex({
  docs,
  active,
  pendingSlug,
  onOpen,
  onCreate,
  onArchive,
  onDelete,
  onExit,
}: {
  docs: NoteDoc[];
  active: boolean;
  pendingSlug: string | null;
  onOpen: (slug: string) => void;
  onCreate: (title: string) => void;
  onArchive: (doc: NoteDoc) => void;
  onDelete: (doc: NoteDoc) => void;
  onExit: () => void;
}) {
  const [query, setQuery] = useState("");
  // -1 means "no row highlighted yet": rows stay uniform until the user arrows
  // (or hovers). Enter still acts on the obvious target — see onInputKeyDown.
  const [selected, setSelected] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => rankNotes(docs, query), [docs, query]);
  const items = useMemo<IndexItem[]>(() => {
    const list: IndexItem[] = results.map((doc) => ({ kind: "note", doc }));
    // The create row is always present (last) so opening the page already offers
    // "New note" without typing. It carries the trimmed query — empty means a
    // blank, untitled note.
    list.push({ kind: "create", title: query.trim() });
    return list;
  }, [results, query]);

  // Keep the selection in range as the list changes (typing, recency updates).
  // A -1 (nothing highlighted) is preserved.
  useEffect(() => {
    setSelected((i) => Math.min(i, items.length - 1));
  }, [items.length]);

  // Refocus the search input whenever the index becomes the visible view (mount
  // and every Esc-back from the editor).
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (selected < 0) return;
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function activate(item: IndexItem | undefined) {
    if (!item) return;
    if (item.kind === "note") onOpen(item.doc.slug);
    else onCreate(item.title);
  }

  // Drive the keyboard loop from a window listener instead of the input's
  // onKeyDown, so ↑↓/↵/esc work no matter where focus is — clicking the header
  // (settings, tabs) or empty space no longer kills the keys. Printable keys
  // refocus the field and keep filtering, so it behaves like a command palette.
  // Held in a ref so the listener always sees current state without re-binding.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e) => {
    const target = e.target as HTMLElement | null;
    // Let an open overlay (the Archived sheet, a menu) handle its own keys.
    if (target?.closest('[role="dialog"],[role="menu"]')) return;
    // The row action trigger is inside the command-list row. Let it own Enter
    // instead of also activating the selected note through this global handler.
    if (target?.closest("[data-notes-index-actions]")) return;
    if (
      target?.closest("button,a,input,textarea,select") &&
      target !== inputRef.current
    )
      return;
    const input = inputRef.current;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length)
        setSelected((i) => (i < 0 ? 0 : Math.min(i + 1, items.length - 1)));
      input?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length)
        setSelected((i) => (i < 0 ? items.length - 1 : Math.max(i - 1, 0)));
      input?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // The highlighted row, or — when the user typed but hasn't arrowed — the
      // top item (type-and-enter opens the best match, or creates).
      const target =
        selected >= 0 ? items[selected] : query.trim() ? items[0] : undefined;
      activate(target);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // First Esc clears an active query; a second (empty) Esc leaves Notes for
      // the Board — esc takes you all the way back out.
      if (query) {
        setQuery("");
        setSelected(-1);
      } else {
        onExit();
      }
    } else if (
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      document.activeElement !== input
    ) {
      // Typing anywhere resumes filtering: focus the field and append the
      // character (it was dispatched away from the now-unfocused input).
      e.preventDefault();
      setQuery((q) => q + e.key);
      setSelected(-1);
      input?.focus();
    }
  };
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);

  const optionId = (i: number) => `notes-index-option-${i}`;

  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto",
        active ? "flex flex-col" : "hidden",
      )}
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-9 px-6 pt-12 pb-10">
        <div className="flex items-center gap-3 border-b border-border px-1 focus-within:border-muted-foreground/40">
          <SearchIcon className="size-[18px] shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelected(-1);
            }}
            placeholder="Search notes, or type to create…"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="notes-index-list"
            aria-activedescendant={selected >= 0 ? optionId(selected) : undefined}
            className="h-12 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div
          ref={listRef}
          id="notes-index-list"
          role="listbox"
          aria-label="Notes"
          className="flex flex-col gap-0.5"
        >
          {items.map((item, i) =>
            item.kind === "note" ? (
              <ContextMenu key={item.doc.slug}>
                <ContextMenuTrigger className="block">
                  <div
                    id={optionId(i)}
                    data-idx={i}
                    role="option"
                    aria-selected={i === selected}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => activate(item)}
                    className={cn(
                      "group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5",
                      i === selected && "bg-muted",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[15px] font-medium tracking-tight text-foreground">
                          {item.doc.title}
                        </span>
                        <span className="shrink-0 rounded-full border border-border px-1.5 font-mono text-[10px] leading-[1.5] lowercase text-muted-foreground">
                          {item.doc.type}
                        </span>
                      </div>
                      {notePreview(item.doc.content) && (
                        <span className="truncate text-[13px] text-muted-foreground">
                          {notePreview(item.doc.content)}
                        </span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="font-mono text-[11px] lowercase text-muted-foreground/70">
                        {relativeTime(item.doc.updatedAt)}
                      </span>
                      <Menu>
                        <MenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`Actions for ${item.doc.title}`}
                              data-notes-index-actions
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              className="flex size-7 items-center justify-center rounded-lg text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 data-[popup-open]:opacity-100"
                            />
                          }
                        >
                          <EllipsisIcon className="size-4" />
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem
                            disabled={pendingSlug === item.doc.slug}
                            onClick={() => copyNotePath(item.doc.slug)}
                          >
                            <CopyIcon />
                            Copy path
                          </MenuItem>
                          <MenuItem
                            disabled={pendingSlug === item.doc.slug}
                            onClick={() => onArchive(item.doc)}
                          >
                            <ArchiveIcon />
                            Archive
                          </MenuItem>
                          <div className="my-1 h-px bg-border" />
                          <MenuItem
                            disabled={pendingSlug === item.doc.slug}
                            onClick={() => onDelete(item.doc)}
                            className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
                          >
                            <Trash2Icon />
                            Delete
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    </div>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => copyNotePath(item.doc.slug)}>
                    <CopyIcon />
                    Copy path
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={pendingSlug === item.doc.slug}
                    onClick={() => onArchive(item.doc)}
                  >
                    <ArchiveIcon />
                    Archive
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    disabled={pendingSlug === item.doc.slug}
                    variant="destructive"
                    onClick={() => onDelete(item.doc)}
                  >
                    <Trash2Icon />
                    Delete
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ) : (
              <div
                key="__create"
                id={optionId(i)}
                data-idx={i}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => setSelected(i)}
                onClick={() => activate(item)}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5",
                  i === selected && "bg-muted",
                )}
              >
                <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
                {item.title ? (
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="text-[15px] text-muted-foreground">Create</span>
                    <span className="truncate text-[15px] font-medium text-foreground">
                      “{item.title}”
                    </span>
                  </span>
                ) : (
                  <span className="flex-1 text-[15px] text-muted-foreground">
                    New note
                  </span>
                )}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

type View = "raw" | "formatted";
const VIEW_KEY = "hitch:notes-view";

function loadView(): View {
  if (typeof window === "undefined") return "formatted";
  return window.localStorage.getItem(VIEW_KEY) === "raw" ? "raw" : "formatted";
}

// The full-pane editor for a single note. Adapted from TaskEditor minus the
// delegation band / chat: the document model, the formatted ⇄ raw toggle, the
// shared attachment paste/drop path, save-on-flush, and the type pill. It is keyed
// by slug, so a different doc remounts it — useFrontmatterDocument relies on that.
function NoteEditor({
  projectId,
  slug,
  content,
  linkedChat,
  chatRowHandlers,
  onStartChat,
  onSave,
  onFlush,
  registerFlush,
  onArchive,
  onDelete,
  onClose,
}: {
  projectId: Id<"projects">;
  slug: string;
  content: string;
  // The note's linked chat for the foot, or null → launcher/composer.
  linkedChat: ChatRowViewModel | null;
  // Resume/pin/archive/delete handlers for the docked ChatRow (the Chats-tab set).
  chatRowHandlers: {
    onResume: (chat: ChatRowViewModel) => void;
    onPin: (chat: ChatRowViewModel) => void;
    onUnpin: (chat: ChatRowViewModel) => void;
    onArchive: (chat: ChatRowViewModel) => void;
    onUnarchive: (chat: ChatRowViewModel) => void;
    onDelete: (chat: ChatRowViewModel) => void;
  };
  // Start a chat linked to this note from the foot composer.
  onStartChat: (params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) => Promise<void> | void;
  onSave: (slug: string, content: string) => Promise<void>;
  onFlush: (slug: string, content: string) => Promise<void>;
  registerFlush: (fn: () => void) => void;
  onArchive: (slug: string, content: string) => void;
  onDelete: (slug: string) => void;
  onClose: () => void;
}) {
  const draft = useFrontmatterDocument(content);
  const attachments = useAttachments({ projectId, slug, base: "notes" });
  const [view, setView] = useState<View>(loadView);
  const [saving, setSaving] = useState(false);
  // The foot dock's launcher→composer toggle. Local to this (slug-keyed) editor,
  // so it resets when you switch notes. Once a chat is linked, `linkedChat` wins
  // the three-way regardless; the effect below clears this so archiving the chat
  // drops back to the launcher (not the composer).
  const [composing, setComposing] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Once the started chat lands in the query, collapse the composer so the foot
  // shows the ChatRow bar. Keeping `composing` false here means a later archive/
  // delete (linkedChat → null) returns to the launcher, never the composer.
  useEffect(() => {
    if (linkedChat) setComposing(false);
  }, [linkedChat]);

  // The floating "ask dock" at the foot (launcher or linked-task card) is pinned
  // over the bottom of the scroll area, so the scroll viewport must reserve its
  // height — otherwise the caret hides behind it when typing at the bottom. We
  // measure the dock and shrink the viewport via marginBottom (NOT padding); see
  // the long note in TaskEditor for why padding leaves the caret behind the bar.
  const dockWrapRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(56);
  useEffect(() => {
    const el = dockWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h) setDockHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the caret above the floating dock as the document grows — including the
  // bare Enter that opens a fresh line. The browser's native caret-into-view
  // doesn't fire for an empty new line (a collapsed range in an empty block has
  // no rect to scroll to), so without this the new line hides behind the dock
  // until the first character is typed. We nudge on both `input` (typing/paste)
  // AND `keydown` Enter — Lexical handles Enter internally and preventDefaults
  // the beforeinput, so no native `input` event fires for it. The nudge measures
  // the caret (falling back to its block's rect when the range rect is empty,
  // which is exactly the empty-line case) and scrolls just enough to clear the
  // dock — a no-op when the native scroll already kept the caret visible.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const nudge = () =>
      requestAnimationFrame(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0) return;
        const node = sel.anchorNode;
        if (!node || !sc.contains(node)) return; // not the formatted editor
        let rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.height === 0 && rect.top === 0 && rect.bottom === 0) {
          const el = node.nodeType === 3 ? node.parentElement : (node as Element);
          if (el) rect = el.getBoundingClientRect();
        }
        const dock = dockWrapRef.current;
        const safeBottom =
          (dock ? dock.getBoundingClientRect().top : sc.getBoundingClientRect().bottom) - 8;
        const overflow = rect.bottom - safeBottom;
        if (overflow > 0) sc.scrollTop += overflow;
      });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") nudge();
    };
    sc.addEventListener("input", nudge, true);
    sc.addEventListener("keydown", onKeyDown, true);
    return () => {
      sc.removeEventListener("input", nudge, true);
      sc.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  // Latest draft, read by the flush so it never closes over a stale value.
  const draftRawRef = useRef(draft.raw);
  draftRawRef.current = draft.raw;
  // Archive / delete / close-with-save persist their own write and must not be
  // re-saved by the registered flush.
  const skipFlushRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // The deferred "explicit save": NotesView calls this registered flush on a real
  // unmount (tab/project switch). We deliberately do NOT flush from the editor's
  // own unmount effect — under StrictMode that fires a spurious cleanup right
  // after mount, which would delete a just-created empty doc. The cleanup resets
  // it to a no-op so a closed editor can never be re-flushed. Re-registered every
  // render so it sees the latest draft + callback.
  useEffect(() => {
    registerFlush(() => {
      if (skipFlushRef.current) return;
      void onFlush(slug, draftRawRef.current);
    });
    return () => registerFlush(() => {});
  });

  // Land the caret where the user is most likely to start typing (mirrors
  // TaskEditor). Empty title (a fresh doc) → focus the title; else the body. A
  // note created from search has its title set, so the cursor lands in the body.
  useEffect(() => {
    if (view !== "formatted") return;
    if (draft.body.trim() !== "") return;
    const titleEmpty = draft.title.trim() === "";
    const id = requestAnimationFrame(() => {
      if (titleEmpty) titleRef.current?.focus();
      else editorRef.current?.focusEnd();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function appendToBody(snippets: string[]) {
    if (snippets.length === 0) return;
    const base = draft.body.replace(/\s*$/, "");
    const additions = snippets.join("\n\n");
    draft.setBody(base ? `${base}\n\n${additions}\n` : `${additions}\n`);
    requestAnimationFrame(() => editorRef.current?.focusEnd());
  }

  const onDropFilesRef = useRef<(files: File[]) => void>(() => {});
  onDropFilesRef.current = (files: File[]) => {
    void attachments.uploadDropped(files).then(appendToBody);
  };

  const onPasteFilesRef = useRef<(files: File[]) => void>(() => {});
  onPasteFilesRef.current = (files: File[]) => {
    void (async () => {
      const snippets = await attachments.uploadPasted(files);
      if (snippets.length === 0) return;
      const ta = rawRef.current;
      if (viewRef.current === "raw" && ta) {
        const start = ta.selectionStart ?? draft.raw.length;
        const end = ta.selectionEnd ?? start;
        const insertion = snippets.join("\n\n");
        draft.setRaw(draft.raw.slice(0, start) + insertion + draft.raw.slice(end));
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + insertion.length;
          ta.setSelectionRange(pos, pos);
        });
      } else {
        appendToBody(snippets);
      }
    })();
  };

  // Whole-pane file drop + paste, captured before Lexical sees them (see the
  // TaskEditor note for the capture-phase rationale).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth += 1;
      setDraggingFile(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDraggingFile(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      setDraggingFile(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onDropFilesRef.current(files);
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      const allImages = files.every((f) => f.type.startsWith("image/"));
      if (viewRef.current === "formatted" && allImages) return;
      e.preventDefault();
      e.stopPropagation();
      onPasteFilesRef.current(files);
    };
    el.addEventListener("dragenter", onEnter, true);
    el.addEventListener("dragover", onOver, true);
    el.addEventListener("dragleave", onLeave, true);
    el.addEventListener("drop", onDrop, true);
    el.addEventListener("paste", onPaste, true);
    return () => {
      el.removeEventListener("dragenter", onEnter, true);
      el.removeEventListener("dragover", onOver, true);
      el.removeEventListener("dragleave", onLeave, true);
      el.removeEventListener("drop", onDrop, true);
      el.removeEventListener("paste", onPaste, true);
    };
  }, []);

  // Explicit checkpoint save (⌘S): write in place, never renaming the folder.
  async function saveDraft() {
    if (!draft.dirty || saving) return;
    setSaving(true);
    try {
      await onSave(slug, draft.raw);
    } finally {
      setSaving(false);
    }
  }

  // Esc / ← Notes: return to the index immediately while the save fires in the
  // background — the same dismiss feel as the task dialog (close now, persist
  // after). skipFlush stops the registered flush from double-writing.
  function closeWithSave() {
    skipFlushRef.current = true;
    void onFlush(slug, draftRawRef.current);
    onClose();
  }

  // Commit a type change immediately (it's a discrete property edit, like a
  // select): fold it into the draft and save in place.
  function commitType(value: string) {
    const next = docType(value);
    if (next === docType(draft.frontmatter.type)) return;
    const content = draft.setFrontmatter({ type: next });
    void onSave(slug, content);
  }

  function copyPath() {
    copyNotePath(slug);
  }

  function archiveDoc() {
    skipFlushRef.current = true;
    onArchive(slug, draft.raw);
    onClose();
  }
  function deleteDoc() {
    skipFlushRef.current = true;
    onDelete(slug);
    onClose();
  }

  // Esc / ⌘S must work even when neither the title nor body is focused (you
  // clicked a toolbar button, or nothing is focused). A root onKeyDown only fires
  // when focus is inside the editor, so listen on the window. Skip events from an
  // open overlay (actions menu, Archived sheet) so Esc closes that first; the type
  // pill stops its own Escape from propagating this far.
  const keyHandlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveDraft();
      return;
    }
    if (e.key === "Escape") {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[role="dialog"],[role="menu"]')) return;
      e.preventDefault();
      closeWithSave();
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyHandlerRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div ref={rootRef} className="relative flex min-h-0 flex-1 flex-col">
      {/* Top bar: ← Notes (left), actions (right). Borderless and flush with the
          body — no separator rule, matching the quiet Paper design. */}
      <div className="flex h-12 shrink-0 items-center justify-between px-6">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={closeWithSave}
                aria-label="Back to notes"
                className="flex items-center gap-1 rounded-lg py-1 pr-2.5 pl-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            }
          >
            <ChevronLeftIcon className="size-4" />
            Notes
          </TooltipTrigger>
          <TooltipContent>Back to notes · esc</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1.5">
          {saving && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              Saving…
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={copyPath}>
            <CopyIcon />
            Copy path
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label="Note actions"
                  className="flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                onClick={() => setView(view === "raw" ? "formatted" : "raw")}
              >
                {view === "raw" ? <AlignLeftIcon /> : <CodeIcon />}
                {view === "raw" ? "Formatted view" : "Raw markdown"}
              </MenuItem>
              <div className="my-1 h-px bg-border" />
              <MenuItem onClick={copyPath}>
                <CopyIcon />
                Copy path
              </MenuItem>
              <MenuItem onClick={archiveDoc}>
                <ArchiveIcon />
                Archive
              </MenuItem>
              <div className="my-1 h-px bg-border" />
              <MenuItem
                onClick={deleteDoc}
                className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
              >
                <Trash2Icon />
                Delete
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      {/* Scroll area: title + body (or raw textarea). Content rides in a centered,
          capped-width column (a comfortable reading measure) so lines never run
          the full pane width — the papery, focused feel. */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-auto flex-col overflow-y-auto px-6 pt-8"
        // The document scrolls UNDER the floating dock so the dock reads as
        // hovering over the text (not a footer): the column's paddingBottom lets
        // the last line clear past the dock, and scrollPaddingBottom keeps the
        // caret above the dock when typing at the bottom. The +24 is the dock's
        // bottom-4 inset plus a small gap.
        style={{ scrollPaddingBottom: dockHeight + 24 }}
        onMouseDown={(e) => {
          if (view === "formatted" && e.target === e.currentTarget) {
            e.preventDefault();
            editorRef.current?.focusEnd();
          }
        }}
      >
        <div
          className="mx-auto flex w-full max-w-[680px] flex-1 flex-col"
          style={{ paddingBottom: dockHeight + 24 }}
        >
          {view === "formatted" ? (
            <>
              {/* The freeform OKF type lives above the title in the document, not
                  in the top bar — it reads as a property of the note. */}
              <div className="mb-4 flex">
                <TypePill
                  type={docType(draft.frontmatter.type)}
                  onCommit={commitType}
                />
              </div>
              <textarea
                ref={titleRef}
                aria-label="Note title"
                rows={1}
                value={draft.title}
                onChange={(e) => draft.setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    editorRef.current?.focusStart();
                  }
                }}
                placeholder="Untitled"
                spellCheck={false}
                className="hitch-autosize mb-3 w-full shrink-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-[34px] font-semibold leading-tight tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
              />
              <MarkdownEditor
                ref={editorRef}
                value={draft.body}
                onChange={draft.setBody}
                placeholder="Jot something down for agents to read — drop in a screenshot or file"
                imageUploadHandler={
                  attachments.enabled ? attachments.imageUploadHandler : undefined
                }
                imagePreviewHandler={
                  attachments.enabled ? attachments.imagePreviewHandler : undefined
                }
              />
            </>
          ) : (
            <textarea
              ref={rawRef}
              aria-label="Note content"
              value={draft.raw}
              onChange={(e) => draft.setRaw(e.target.value)}
              spellCheck={false}
              autoFocus
              className="hitch-autosize min-h-[180px] w-full shrink-0 resize-none overflow-hidden bg-transparent font-mono text-xs leading-relaxed outline-none"
            />
          )}
        </div>
      </div>

      {/* Floating "ask dock", pinned over the bottom of the note and centered on
          the document column. Three states (the locked Notes-chat design): no
          chat → a calm launcher pill; clicking it expands the real Chats-tab
          composer in place (prefilled "I need your help in <path>"); a linked
          chat → the real ChatRow bar, identical to the Chats tab. It hangs here
          as the user scrolls — see the marginBottom note. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-6">
        <div
          ref={dockWrapRef}
          className="pointer-events-auto flex w-full max-w-[680px] justify-center"
        >
          {linkedChat ? (
            <div className="w-full">
              <ChatRow chat={linkedChat} {...chatRowHandlers} />
            </div>
          ) : composing ? (
            <div className="w-full">
              <ChatComposer
                defaultPrompt={`I need your help in ${noteBodyPath(slug)} `}
                label={null}
                wide
                onStart={onStartChat}
              />
            </div>
          ) : (
            <NoteLauncher onLaunch={() => setComposing(true)} />
          )}
        </div>
      </div>

      {draggingFile && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/30 bg-background/85 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </div>
        </div>
      )}

      {attachments.uploading > 0 && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <LoaderCircle className="size-3.5 animate-spin" />
          Uploading…
        </div>
      )}
    </div>
  );
}

// The resting foot of a note with no chat linked: a calm pill that expands the
// real Chats-tab composer in place (no modal, no navigation). Once a chat is
// linked, this is replaced by the ChatRow bar; archiving/deleting it returns here.
function NoteLauncher({ onLaunch }: { onLaunch: () => void }) {
  return (
    <button
      type="button"
      onClick={onLaunch}
      className="group inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3.5 py-2 text-[13px] text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
    >
      <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium text-foreground/80 group-hover:text-foreground">
        Chat with or edit this note
      </span>
    </button>
  );
}

// The freeform OKF type, shown as an editable pill. Click → inline input; commit
// on Enter/blur (empty → "note"). Escape cancels back to the current value (and
// is swallowed so it doesn't also close the editor).
function TypePill({
  type,
  onCommit,
}: {
  type: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(type);
  const cancelled = useRef(false);

  useEffect(() => {
    setValue(type);
  }, [type]);

  if (editing) {
    return (
      <input
        autoFocus
        aria-label="Note type"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (!cancelled.current) onCommit(value);
          cancelled.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelled.current = true;
            setValue(type);
            e.currentTarget.blur();
          }
        }}
        spellCheck={false}
        className="w-32 rounded-md bg-muted px-2.5 py-0.5 text-xs lowercase outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={`Type: ${type}. Click to edit`}
      onClick={() => {
        setValue(type);
        setEditing(true);
      }}
      className="rounded-md bg-muted px-2.5 py-0.5 text-xs lowercase text-muted-foreground hover:text-foreground"
    >
      {type}
    </button>
  );
}

function NotesArchivedSheet({
  open,
  onOpenChange,
  docs,
  pendingSlug,
  onUnarchive,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docs: NoteDoc[];
  pendingSlug: string | null;
  onUnarchive: (doc: NoteDoc) => void;
  onDelete: (doc: NoteDoc) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0">
        <SheetHeader>
          <SheetTitle>Archived</SheetTitle>
          <SheetDescription>
            {docs.length} archived note{docs.length === 1 ? "" : "s"}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          {docs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing archived.</p>
          ) : (
            docs.map((doc) => (
              <div
                key={doc.slug}
                className="flex items-center gap-2 rounded-md border border-border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{doc.title}</p>
                  <p className="text-xs text-muted-foreground">{doc.type}</p>
                </div>
                <button
                  type="button"
                  aria-label="Unarchive"
                  disabled={pendingSlug === doc.slug}
                  onClick={() => onUnarchive(doc)}
                  className="flex size-7 items-center justify-center rounded-lg border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <ArchiveRestoreIcon className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label="Delete"
                  disabled={pendingSlug === doc.slug}
                  onClick={() => onDelete(doc)}
                  className="flex size-7 items-center justify-center rounded-lg border text-[#B42318] hover:bg-[#B42318]/10 disabled:opacity-50"
                >
                  <Trash2Icon className="size-4" />
                </button>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
