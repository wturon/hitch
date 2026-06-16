"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  AlignLeftIcon,
  ArchiveIcon,
  CodeIcon,
  CopyIcon,
  EllipsisIcon,
  LoaderCircle,
  PaperclipIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import { taskSlug } from "@/lib/tasks";
import type { Harness } from "@/lib/chat";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { useAttachments } from "@/hooks/useAttachments";
import { DelegationBand } from "@/components/DelegationBand";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/MarkdownEditor";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

// What the dialog needs to render and save a task. `content` is the raw file
// text (frontmatter + body); we edit it wholesale and write it back verbatim.
export interface TaskTarget {
  projectId: Id<"projects">;
  path: string; // tasks/<slug>/task.md
  title: string;
  content: string;
}

// Raw = the honest full-file textarea (frontmatter + body, edited verbatim, and
// the only place to edit frontmatter). Formatted = the friendly MDXEditor body
// editor (symbol-free WYSIWYG). The choice is remembered globally.
type View = "raw" | "formatted";
const VIEW_KEY = "hitch:task-view";

// Height of the floating top chrome / sticky header (matches the scroll area's
// pt-14 and the header bar's h-14). The formatted title counts as "scrolled
// out" once its bottom passes this line.
const HEADER_H = 56;

function loadView(): View {
  if (typeof window === "undefined") return "formatted";
  // Anything other than an explicit "raw" (incl. the legacy "reading") →
  // formatted, so the stored preference migrates cleanly.
  return window.localStorage.getItem(VIEW_KEY) === "raw" ? "raw" : "formatted";
}

export function TaskDialog({
  task,
  onOpenChange,
  onArchive,
  onDelete,
  onManagePrompts,
  onManageHarnesses,
}: {
  task: TaskTarget | null;
  onOpenChange: (open: boolean) => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}) {
  // The editor owns the save-on-close path (it holds the draft). All dismissals
  // — the X, Escape, and backdrop — route through the function it registers
  // here, so each one saves a dirty draft before the dialog actually closes.
  const closeWithSaveRef = useRef<(() => void) | null>(null);

  return (
    <Dialog
      open={task !== null}
      onOpenChange={(open) => {
        if (open) {
          onOpenChange(true);
          return;
        }
        if (closeWithSaveRef.current) closeWithSaveRef.current();
        else onOpenChange(false);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] min-h-[340px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        {task && (
          // Key by identity so the editor's draft state resets per task,
          // rather than persisting a stale draft when a different card opens.
          // useTaskDraft relies on this remount for its initialization — see
          // the note there. Don't remove the key.
          <TaskEditor
            key={task.path}
            task={task}
            onClose={() => onOpenChange(false)}
            registerClose={(fn) => {
              closeWithSaveRef.current = fn;
            }}
            onArchive={onArchive}
            onDelete={onDelete}
            onManagePrompts={onManagePrompts}
            onManageHarnesses={onManageHarnesses}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskEditor({
  task,
  onClose,
  registerClose,
  onArchive,
  onDelete,
  onManagePrompts,
  onManageHarnesses,
}: {
  task: TaskTarget;
  onClose: () => void;
  registerClose: (fn: () => void) => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}) {
  const upsertFile = useMutation(api.files.upsertFile);
  const enqueue = useMutation(api.commands.enqueueCommand);
  // The whole document model lives in the hook: the full-file draft, the
  // body/title/frontmatter selectors, the document mutations, dirty tracking,
  // and adoption of external writes. This component owns only the things around
  // it — persistence, close policy, focus, and chrome.
  const draft = useTaskDraft(task.content);
  // The task folder slug, used to scope attachment paths/queries to this task.
  const slug = taskSlug(task.path);
  // Shared upload path for both the editor's image paste and the dialog-wide
  // file drop below. Inert (enabled: false) for a task with no slug.
  const attachments = useAttachments(
    slug ? { projectId: task.projectId, slug } : undefined,
  );
  const [view, setView] = useState<View>(loadView);
  const [saving, setSaving] = useState(false);
  const closeInFlightRef = useRef(false);
  // Focus-only handle into the editor; content flows through value/onChange.
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // The raw-view textarea, so a paste lands at its caret.
  const rawRef = useRef<HTMLTextAreaElement>(null);
  // The scroll area and the floating delegate-bar wrapper. We measure the band
  // so the scroll area can reserve exactly its height (it grows when the prompt
  // editor expands), and we watch the scroll position to drive the header.
  const scrollRef = useRef<HTMLDivElement>(null);
  const bandWrapRef = useRef<HTMLDivElement>(null);
  // Live delegate-bar height; seeds at the compact size so first paint matches.
  const [bandHeight, setBandHeight] = useState(96);
  // Scrolled at all (→ show the hairline divider) and, in formatted view,
  // whether the document's own title has scrolled up under the header.
  const [scrolled, setScrolled] = useState(false);
  const [titleScrolledOut, setTitleScrolledOut] = useState(false);
  // The whole-dialog drop surface. Files dropped anywhere inside upload and get
  // appended to the body as standard markdown (images render inline, other
  // files become `[name](path)` links).
  const rootRef = useRef<HTMLDivElement>(null);
  const [draggingFile, setDraggingFile] = useState(false);
  // The listeners below are bound once (deps: [slug]); read live state through
  // refs so they never re-bind on every keystroke yet always see the latest.
  const viewRef = useRef(view);
  viewRef.current = view;
  // Live band height for the caret-keeper below (avoids re-binding its listener).
  const bandHeightRef = useRef(bandHeight);
  bandHeightRef.current = bandHeight;

  // Append uploaded markdown at the end of the body (formatted view, and all
  // drops). Cursor-position insertion isn't worth the markdown-offset mapping;
  // "lands at the bottom" is predictable and matches how attachments accrue.
  function appendToBody(snippets: string[]) {
    if (snippets.length === 0) return;
    const base = draft.body.replace(/\s*$/, "");
    const additions = snippets.join("\n\n");
    draft.setBody(base ? `${base}\n\n${additions}\n` : `${additions}\n`);
    requestAnimationFrame(() => editorRef.current?.focusEnd());
  }

  // Latest drop handler, read by the stable native listeners below.
  const onDropFilesRef = useRef<(files: File[]) => void>(() => {});
  onDropFilesRef.current = (files: File[]) => {
    void attachments.uploadDropped(files).then(appendToBody);
  };

  // Latest file-paste handler. In raw view we splice at the textarea caret (it
  // has a real selection); in formatted view we append at the end like a drop.
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

  // Native (not React-synthetic) drag listeners in the CAPTURE phase on the
  // dialog root: capture + stopPropagation means we intercept the drop before it
  // reaches Lexical's own drop handler, so ALL file drops route through our one
  // path (uniform behavior, whole-dialog coverage) while clipboard paste — a
  // different event — keeps flowing to the image plugin untouched. We gate on a
  // "Files" drag so dragging text or repositioning a node is left alone.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !slug) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    // dragenter/leave fire per child element; count depth so moving across the
    // editor's inner nodes doesn't flicker the overlay off.
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
    // Clipboard paste of files, in the CAPTURE phase so we decide before Lexical
    // does. In formatted view an image-only paste is left to the editor's image
    // plugin (it inserts at the caret — nicer than appending); everything else
    // (any non-image file, or any paste in raw view) we handle ourselves so both
    // views accept pasted files identically. A fileless paste (plain text) falls
    // straight through to normal paste.
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
  }, [slug]);

  useEffect(() => {
    window.localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // Reserve room under the floating delegate bar equal to its real height, so
  // the last lines of the document always clear it (the band grows tall when
  // the prompt editor is expanded — a fixed inset would leave text behind it).
  useEffect(() => {
    const el = bandWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h) setBandHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-evaluate the header when the view toggles: content height changes, and
  // the raw view has no rendered title to track (the header title is shown
  // there at all times — see showHeaderTitle).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      setScrolled(el.scrollTop > 4);
      const t = titleRef.current;
      setTitleScrolledOut(
        view === "formatted" && t
          ? t.getBoundingClientRect().bottom <=
              el.getBoundingClientRect().top + HEADER_H
          : false,
      );
    });
    return () => cancelAnimationFrame(id);
  }, [view]);

  // Keep the caret above the floating delegate bar while typing in the FORMATTED
  // editor. The raw textarea is handled natively (the scroll area's
  // scrollPaddingBottom keeps the browser's caret-into-view above the bar), but
  // MDXEditor/Lexical runs its own scroll-into-view that ignores scroll-padding
  // and parks the caret at the real bottom edge — behind the bar. So after each
  // selection change we measure the caret and, only when it has slipped under
  // the bar (i.e. the modal is at max height), nudge the scroll container up by
  // the overflow. A no-op otherwise, and untouched in raw view.
  useEffect(() => {
    const onSelectionChange = () => {
      if (viewRef.current !== "formatted") return;
      const el = scrollRef.current;
      const sel = window.getSelection();
      if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.focusNode)) {
        return;
      }
      requestAnimationFrame(() => {
        const s = window.getSelection();
        if (!s || s.rangeCount === 0 || !el.contains(s.focusNode)) return;
        let rect = s.getRangeAt(0).getBoundingClientRect();
        // A collapsed caret on an empty line can report a zero-height rect; fall
        // back to the focused block element's box.
        if (rect.height === 0) {
          const node = s.focusNode;
          const block = node instanceof Element ? node : node?.parentElement;
          if (block) rect = block.getBoundingClientRect();
        }
        const safeBottom =
          el.getBoundingClientRect().bottom - (bandHeightRef.current + 32);
        if (rect.bottom > safeBottom) el.scrollTop += rect.bottom - safeBottom;
      });
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", onSelectionChange);
  }, []);

  // Land the caret where the user is most likely to start typing the moment a
  // task opens, so an empty task needs no click. Only the formatted view (raw
  // already autofocuses its textarea). An empty body → focus the body editor;
  // an empty title *and* body (a fresh task) → focus the title instead. Anything
  // with a body is left alone so reopening a real task doesn't grab focus.
  //
  // Runs once on mount — the editor is keyed per task, so a different task
  // remounts this. Deferred a frame because the body editor is MDXEditor
  // (Lexical mounts async) and the Dialog applies its own initial focus; by the
  // next frame both have settled and our focus call wins.
  useEffect(() => {
    if (view !== "formatted") return;
    if (draft.body.trim() !== "") return;
    const titleEmpty = draft.title.trim() === "";
    const id = requestAnimationFrame(() => {
      if (titleEmpty) titleRef.current?.focus();
      else editorRef.current?.focusEnd();
    });
    return () => cancelAnimationFrame(id);
    // Mount-only: a remount (new task) is the only time we want to grab focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function persist(content: string) {
    await upsertFile({
      projectId: task.projectId,
      path: task.path,
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  // Explicit save (⌘S) — write the current draft without closing. No-op when
  // the draft is clean.
  async function saveDraft() {
    if (!draft.dirty || saving) return;
    setSaving(true);
    try {
      await persist(draft.raw);
    } finally {
      setSaving(false);
    }
  }

  // The single close path: close immediately, then save iff dirty. Never prompts.
  // The ref guard keeps repeated X/Escape/backdrop events from enqueueing a pile
  // of identical writes during the same dismiss.
  function closeWithSave() {
    if (closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    const content = draft.raw;
    const shouldPersist = draft.dirty;
    onClose();

    if (!shouldPersist) return;
    void persist(content).catch((error) => {
      console.error("Failed to save task after closing modal", error);
    });
  }

  // Keep the registered close handler pointing at the latest draft/dirty state.
  useEffect(() => {
    registerClose(() => void closeWithSave());
  });

  // Save the current edits (only when dirty), then ask the daemon to spawn the
  // session. We keep the modal open: the daemon links the session into the file,
  // the live task flows back, and the band swaps to its linked state on its own.
  // model/effort ride the command for the kickoff only — never written to the task.
  async function startChat({
    harness,
    model,
    effort,
    prompt,
  }: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) {
    if (draft.dirty) await persist(draft.raw);
    await enqueue({
      projectId: task.projectId,
      kind: "start-chat",
      harness,
      path: task.path,
      initialPrompt: prompt,
      model,
      effort,
    });
  }

  async function clearChat() {
    // Only frontmatter changes, so the body editor needs no update.
    await persist(draft.clearChat());
  }

  function copyPath() {
    void navigator.clipboard.writeText(task.path).catch(() => {
      // Clipboard can be unavailable (e.g. no permission); silently ignore.
    });
  }

  // Archive / Delete reuse the board's operations (passed down from App). Both
  // fire-and-close; Delete is one-click (no confirm). We close without saving so
  // the archive/delete write isn't immediately overwritten by a draft save.
  function archiveTask() {
    onArchive?.();
    onClose();
  }
  function deleteTask() {
    onDelete?.();
    onClose();
  }

  // The title shown in the sticky header. Always rendered in raw view (which has
  // no big rendered title); in formatted view it fades in only once the
  // document's own title has scrolled up under the header.
  const displayTitle = draft.frontmatter.title || task.title || "Untitled";
  const showHeaderTitle = view === "raw" || titleScrolledOut;
  // The divider + opaque background ride in with the title, never before it — so
  // formatted view never flashes a bar over the still-visible document title.
  const showHeaderChrome = scrolled && showHeaderTitle;

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-auto flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveDraft();
        }
      }}
    >
      {/* Sticky header. The task title slides in here once the document's own
          title scrolls out of view (always shown in raw, which has no rendered
          title). A hairline divider + opaque background appear on scroll so the
          body flows cleanly underneath; at the top it's invisible, keeping the
          calm open-document feel. pointer-events-none so the body and the
          controls below stay clickable through it. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex h-14 items-center border-b pr-20 pl-6 transition-colors",
          showHeaderChrome ? "border-border bg-background" : "border-transparent",
        )}
      >
        <span
          className={cn(
            "min-w-0 truncate text-sm font-semibold text-foreground transition-opacity duration-150",
            showHeaderTitle ? "opacity-100" : "opacity-0",
          )}
        >
          {displayTitle}
        </span>
      </div>

      {/* Top-right controls — ⋯ overflow menu then the X, both floating with the
          same surface treatment. The view switch (Raw ⇄ Formatted) lives in the
          menu now, keeping the modal's top chrome to just these two buttons. */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Task actions"
                className="flex size-7 items-center justify-center rounded-lg border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
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
              Copy task path
            </MenuItem>
            {onArchive && (
              <MenuItem onClick={archiveTask}>
                <ArchiveIcon />
                Archive
              </MenuItem>
            )}
            {onDelete && (
              <>
                <div className="my-1 h-px bg-border" />
                <MenuItem
                  onClick={deleteTask}
                  className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
                >
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>

        <button
          type="button"
          aria-label="Close"
          disabled={saving}
          onClick={closeWithSave}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg border bg-background text-muted-foreground",
            "hover:bg-muted hover:text-foreground disabled:pointer-events-none",
          )}
        >
          {saving ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <XIcon className="size-4" />
          )}
        </button>
      </div>

      {/* Scroll area — grows with its content; the modal's max-h caps it and
          scrolling kicks in past that (Linear-style: short by default, taller as
          you type). Top padding clears the floating chrome; bottom padding leaves
          room for the floating delegate bar; the wider px-6 adds breathing room.
          A mousedown on the empty area (formatted) drops the caret into the
          body — handy now that the modal can be short. */}
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScrolled(el.scrollTop > 4);
          if (view === "formatted") {
            const t = titleRef.current;
            setTitleScrolledOut(
              !!t &&
                t.getBoundingClientRect().bottom <=
                  el.getBoundingClientRect().top + HEADER_H,
            );
          }
        }}
        className="flex min-h-0 flex-auto flex-col overflow-y-auto px-6 pt-14"
        // paddingBottom reserves room so the doc clears the floating bar when
        // scrolled to the end. scrollPaddingBottom is the live half: it shrinks
        // the scrollport's "visible region" by the same inset, so the browser's
        // caret-into-view scroll (while typing at max height) keeps the caret
        // above the bar instead of parking it behind the overlay.
        style={{
          paddingBottom: bandHeight + 32,
          scrollPaddingBottom: bandHeight + 32,
        }}
        onMouseDown={(e) => {
          if (view === "formatted" && e.target === e.currentTarget) {
            e.preventDefault();
            editorRef.current?.focusEnd();
          }
        }}
      >
        {view === "formatted" ? (
          <>
            {/* Notion-style title: borderless, plain background, no focus ring.
                A textarea (not an input) so a long title wraps and auto-grows
                (`field-sizing: content`) instead of scrolling sideways. It's a
                single YAML scalar, so newlines are stripped and Enter drops focus
                into the body. The value is read untrimmed (see `rawTitle`) so the
                spacebar works. `p-0` keeps it flush-left with the body. */}
            <textarea
              ref={titleRef}
              aria-label="Task title"
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
              placeholder="Describe what you're working on, or drop in a screenshot or file"
              imageUploadHandler={
                attachments.enabled ? attachments.imageUploadHandler : undefined
              }
              imagePreviewHandler={
                attachments.enabled
                  ? attachments.imagePreviewHandler
                  : undefined
              }
            />
          </>
        ) : (
          <textarea
            ref={rawRef}
            aria-label="Task content"
            value={draft.raw}
            onChange={(e) => draft.setRaw(e.target.value)}
            spellCheck={false}
            autoFocus
            className="hitch-autosize min-h-[180px] w-full shrink-0 resize-none overflow-hidden bg-transparent font-mono text-xs leading-relaxed outline-none"
          />
        )}
      </div>

      {/* Floating delegate bar, pinned over the bottom of the document. */}
      <div className="pointer-events-none absolute inset-x-6 bottom-4 z-10">
        <div ref={bandWrapRef} className="pointer-events-auto">
          <DelegationBand
            projectId={task.projectId}
            chat={draft.chat}
            chatStatus={draft.chatStatus}
            chatOpenState={draft.chatOpenState}
            title={draft.frontmatter.title || task.title}
            path={task.path}
            onStart={startChat}
            onClear={() => void clearChat()}
            onManagePrompts={onManagePrompts}
            onManageHarnesses={onManageHarnesses}
          />
        </div>
      </div>

      {/* Drop-zone affordance: covers the whole dialog while a file is dragged
          over it, so the user gets "yes, drop here" feedback the editor never
          showed on its own. pointer-events-none so it never swallows the drag
          events our root listener is counting. */}
      {draggingFile && (
        <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/30 bg-background/85 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <PaperclipIcon className="size-4" />
            Drop files to attach
          </div>
        </div>
      )}

      {/* In-flight upload feedback (MDXEditor shows nothing during upload). */}
      {attachments.uploading > 0 && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-md border bg-background/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          <LoaderCircle className="size-3.5 animate-spin" />
          Uploading…
        </div>
      )}
    </div>
  );
}
