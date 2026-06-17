"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  AlignLeftIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CodeIcon,
  CopyIcon,
  EllipsisIcon,
  FileTextIcon,
  LoaderCircle,
  PaperclipIcon,
  PlusIcon,
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
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// A note is a folder under notes/, its body in index.md. This is the in-memory
// model the explorer renders, mirroring the board's Card. `content` is the raw
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
}: {
  projectId: Id<"projects">;
  files: FileDoc[];
  // The Archived sheet is opened from the shared workspace header (top-right),
  // so its open state is owned by the parent and threaded back in here.
  showArchived: boolean;
  onShowArchivedChange: (open: boolean) => void;
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

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  // The open editor registers its draft-flush here; we call it before swapping
  // the selection, creating another doc, or unmounting (tab/project switch).
  const flushRef = useRef<() => void>(() => {});

  // Flush the open doc on a real unmount (the tab or project changed). Safe under
  // StrictMode's mount→unmount→mount: at first mount nothing is selected, so the
  // ref is still the no-op default.
  useEffect(() => () => flushRef.current(), []);

  const docs = useMemo(() => noteDocs(files), [files]);
  const activeDocs = docs.filter((d) => !d.archived);
  const archivedDocs = docs.filter((d) => d.archived);
  const selected = selectedSlug
    ? (docs.find((d) => d.slug === selectedSlug && !d.archived) ?? null)
    : null;

  // Group active docs by type; groups ordered alphabetically (MVP). Within a
  // group, most-recently-updated first so a freshly created/edited doc surfaces.
  const groups = useMemo(() => {
    const byType = new Map<string, NoteDoc[]>();
    for (const doc of activeDocs) {
      const list = byType.get(doc.type) ?? [];
      list.push(doc);
      byType.set(doc.type, list);
    }
    return [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, list]) => ({
        type,
        docs: list.sort((a, b) => b.updatedAt - a.updatedAt),
      }));
  }, [activeDocs]);

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

  // Create a fresh doc of `type` with an empty title, select it, and let the
  // editor focus the title. The slug is recomputed from the title on flush, so a
  // placeholder "note"/"note-2" slug here is fine. An empty doc is discarded on
  // flush, so an accidental "new" click leaves nothing behind.
  async function createDoc(type: string) {
    flushRef.current(); // save/reconcile the doc we're leaving
    const taken = new Set(docs.map((d) => d.slug));
    const slug = uniqueSlug("", taken, DEFAULT_TYPE);
    const content = setFrontmatterKeys("", {
      type: docType(type),
      created: new Date().toISOString(),
    });
    setSelectedSlug(slug);
    await persist(noteBodyPath(slug), content);
  }

  // In-place save (⌘S and the type pill): write the draft at its current path,
  // never recomputing the slug. Slug reconciliation is deferred to flush so the
  // folder doesn't churn mid-edit.
  async function saveDoc(slug: string, content: string) {
    await persist(noteBodyPath(slug), content);
  }

  // The deferred "explicit save" that also reconciles the slug — called when the
  // editor unmounts (the doc is deselected, another doc is opened, or the tab
  // changes). Discards an empty doc; renames the folder when the title's slug has
  // drifted (write new path + migrate attachments + tombstone old).
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

  // Switch the selected doc, flushing the outgoing draft first (save + slug
  // reconcile). Selecting the doc already open is a no-op.
  function selectDoc(slug: string) {
    if (slug === selectedSlug) return;
    flushRef.current();
    setSelectedSlug(slug);
  }

  return (
    <div className="-mx-4 flex min-h-0 flex-1 sm:-mx-6 lg:-mx-8">
      {/* Left: whisper-quiet explorer, grouped by type. No column title (the
          Board/Notes tab already labels the view) and no per-row icons — bare
          titles. The New affordance rides on the first group's header row. */}
      <aside className="flex w-[236px] shrink-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pt-3 pb-4">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
              <p className="text-sm font-medium text-foreground">No notes yet</p>
              <p className="text-xs text-muted-foreground">
                Jot something down for agents to read.
              </p>
              <button
                type="button"
                onClick={() => void createDoc(DEFAULT_TYPE)}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <PlusIcon className="size-3.5" />
                New note
              </button>
            </div>
          ) : (
            groups.map((group, i) => (
              <div key={group.type} className="group flex flex-col">
                <div className="flex items-center justify-between px-2 py-1">
                  <span className="font-mono text-[10px] lowercase text-muted-foreground/60">
                    {group.type}
                  </span>
                  {/* The first group's "+" is the always-visible New affordance;
                      later groups reveal their per-group "New [type]" on hover. */}
                  <button
                    type="button"
                    aria-label={`New ${group.type} note`}
                    onClick={() => void createDoc(group.type)}
                    className={cn(
                      "flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                      i === 0 ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                </div>
                {group.docs.map((doc) => (
                  <button
                    key={doc.slug}
                    type="button"
                    onClick={() => selectDoc(doc.slug)}
                    className={cn(
                      "truncate rounded-md px-2 py-1.5 text-left text-[13px]",
                      doc.slug === selectedSlug
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {doc.title}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Right: editor pane. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selected ? (
          <NoteEditor
            key={selected.slug}
            projectId={projectId}
            slug={selected.slug}
            content={selected.content}
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
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <FileTextIcon className="size-8 opacity-40" />
            <p className="text-sm">Select a note, or create one.</p>
          </div>
        )}
      </div>

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

type View = "raw" | "formatted";
const VIEW_KEY = "hitch:notes-view";

function loadView(): View {
  if (typeof window === "undefined") return "formatted";
  return window.localStorage.getItem(VIEW_KEY) === "raw" ? "raw" : "formatted";
}

// The right-pane editor for a single note. Adapted from TaskEditor minus
// the delegation band / chat: the document model, the formatted ⇄ raw toggle, the
// shared attachment paste/drop path, save-on-flush, and the type pill. It is keyed
// by slug, so a different doc remounts it — useFrontmatterDocument relies on that.
function NoteEditor({
  projectId,
  slug,
  content,
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
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Latest draft, read by the flush so it never closes over a stale value.
  const draftRawRef = useRef(draft.raw);
  draftRawRef.current = draft.raw;
  // Archive / delete persist their own write and must not be re-saved by the
  // flush that fires when we then deselect.
  const skipFlushRef = useRef(false);

  useEffect(() => {
    window.localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // The deferred "explicit save": NotesView calls this registered flush right
  // before it swaps the selected doc, creates another, or unmounts (a tab/project
  // switch). We deliberately do NOT flush from the editor's own unmount effect —
  // under StrictMode that fires a spurious cleanup immediately after mount, which
  // would delete a just-created empty doc. Driving it from the parent's explicit
  // actions sidesteps that; skipFlush suppresses it once archive/delete have
  // written. Re-registered every render so it sees the latest draft + callback.
  useEffect(() => {
    registerFlush(() => {
      if (skipFlushRef.current) return;
      void onFlush(slug, draftRawRef.current);
    });
  });

  // Land the caret where the user is most likely to start typing (mirrors
  // TaskEditor). Empty title (a fresh doc) → focus the title; else the body.
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

  // Commit a type change immediately (it's a discrete property edit, like a
  // select): fold it into the draft and save in place so the doc re-groups now.
  function commitType(value: string) {
    const next = docType(value);
    if (next === docType(draft.frontmatter.type)) return;
    const content = draft.setFrontmatter({ type: next });
    void onSave(slug, content);
  }

  function copyPath() {
    // Project-root-relative path (includes .hitch/) — the reading agent's cwd is
    // the project root, so this pastes straight into a live chat.
    void navigator.clipboard
      .writeText(`.hitch/${noteBodyPath(slug)}`)
      .catch(() => {});
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

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveDraft();
        }
      }}
    >
      {/* Top bar: type pill (left), actions (right). Borderless and flush with
          the body — no separator rule, matching the quiet Paper design. */}
      <div className="flex h-12 shrink-0 items-center justify-between px-6">
        <TypePill type={docType(draft.frontmatter.type)} onCommit={commitType} />
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

      {/* Scroll area: title + body (or raw textarea). */}
      <div
        className="flex min-h-0 flex-auto flex-col overflow-y-auto px-6 pt-6 pb-10"
        onMouseDown={(e) => {
          if (view === "formatted" && e.target === e.currentTarget) {
            e.preventDefault();
            editorRef.current?.focusEnd();
          }
        }}
      >
        {view === "formatted" ? (
          <>
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
              className="hitch-autosize mb-2 w-full shrink-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-[22px] font-semibold leading-snug tracking-tight text-foreground outline-none placeholder:text-muted-foreground/40"
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

// The freeform OKF type, shown as an editable pill. Click → inline input; commit
// on Enter/blur (empty → "note"). Escape cancels back to the current value.
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
