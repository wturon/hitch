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
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import type { Harness } from "@/lib/chat";
import { useTaskDraft } from "@/hooks/useTaskDraft";
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
  const [view, setView] = useState<View>(loadView);
  const [saving, setSaving] = useState(false);
  const closeInFlightRef = useRef(false);
  // Focus-only handle into the editor; content flows through value/onChange.
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    window.localStorage.setItem(VIEW_KEY, view);
  }, [view]);

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

  return (
    <div
      className="relative flex min-h-0 flex-auto flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveDraft();
        }
      }}
    >
      {/* Top-right controls — ⋯ overflow menu then the X, both floating with the
          same surface treatment. The view switch (Raw ⇄ Formatted) lives in the
          menu now, keeping the modal's top chrome to just these two buttons. */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
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
        className="flex min-h-0 flex-auto flex-col overflow-y-auto px-6 pt-14 pb-32"
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
              placeholder="What are you working on?"
            />
          </>
        ) : (
          <textarea
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
        <div className="pointer-events-auto">
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
    </div>
  );
}
