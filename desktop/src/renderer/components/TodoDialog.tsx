"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  AlignLeftIcon,
  ArchiveIcon,
  ChevronDown,
  ChevronUp,
  CodeIcon,
  CopyIcon,
  EllipsisIcon,
  GaugeIcon,
  LoaderCircle,
  PencilIcon,
  Settings2Icon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

import {
  BUILTIN_PROMPT_IDS,
  BUILTIN_STARTING_PROMPTS,
  HARNESSES,
  MODELS_BY_HARNESS,
  buildStartPrompt,
  defaultEnvironment,
  defaultReasoning,
  environmentLabel,
  harnessLabel,
  honorsLaunchParams,
  isEnvironment,
  loadCustomPrompts,
  loadLastAgent,
  modelLabel,
  promptDescription,
  reasoningLabel,
  reasoningOptions,
  saveLastAgent,
  stampDelegationRequest,
  type Environment,
  type Harness,
  type StartingPrompt,
} from "@/lib/chat";
import { sha256 } from "@/lib/hash";
import { setFrontmatterKeys } from "@/lib/frontmatter";
import {
  deriveTitleFromBody,
  splitCaptureText,
  taskBodyPath,
  taskSlug,
  uniqueSlug,
} from "@/lib/tasks";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { useAttachments } from "@/hooks/useAttachments";
import { useSkills } from "@/hooks/useSkills";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/editor";
import { HarnessIcon } from "@/components/HarnessIcon";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The two-stage create dialog for the Todos tab (Todos v1, slice 4). One
// component, two stages, transformed IN PLACE:
//   • capture — a chrome-free 560px card, body-only editor. Nothing exists
//     anywhere until ⌘⏎ (except a pasted image, which materializes the task dir
//     early and is deleted on discard). ⏎ newline · ⌘⏎ save · esc cancel.
//   • saved — the same card grown downward: the captured first line crystallizes
//     into the 18px title, the body becomes a document, and the coaching strip
//     becomes the docked delegation panel. Start is fire-and-forget.
//
// The footer render is keyed by an explicit state enum (not booleans) so slice 5
// can add the existing-todo states (linked / requested / completed) without
// reshaping this component. Slice 4 uses "coaching" / "coaching-armed" / "compose".
type TodoFooterState = "coaching" | "coaching-armed" | "compose";

type Stage = "capture" | "saved";

// Raw = the honest full-file textarea (frontmatter + body). Formatted = the
// friendly Lexical body editor. Only reachable in the saved stage's ⋯ menu; the
// choice is remembered globally, sharing the task dialog's key.
type View = "raw" | "formatted";
const VIEW_KEY = "hitch:task-view";
function loadView(): View {
  if (typeof window === "undefined") return "formatted";
  return window.localStorage.getItem(VIEW_KEY) === "raw" ? "raw" : "formatted";
}

// How long ⌘⏎ is swallowed after the capture→saved transform kicks off
// (Decision 5). After it settles, a second ⌘⏎ is a legit power move (delegate).
const TRANSFORM_MS = 260;

export interface TodoDialogProps {
  open: boolean;
  projectId: Id<"projects">;
  // Slugs already on disk, so a fresh capture mints a non-colliding one on save.
  takenSlugs: string[];
  // Close the dialog (the parent owns the `open` flag).
  onClose: () => void;
  // Optimistic upsert by path+content — used for the materialize on ⌘⏎, the
  // early materialize on image paste, and body autosave on close.
  onWrite: (path: string, content: string) => Promise<void>;
  // Cascade-delete a task folder (attachments + task.md tombstone). Used by the
  // discard-cleanup of a pasted-early draft (Decision 3) and the ⋯ Delete action.
  onDeleteTodo: (slug: string) => Promise<void>;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}

export function TodoDialog(props: TodoDialogProps) {
  // Route EVERY dismissal (Escape, outside press, the ✕) through the body's
  // discard-guard / save policy. The body registers its handler here; the Dialog
  // stays controlled by `open`, so cancelling the Base UI change just hands the
  // decision to the body.
  const dismissRef = useRef<(reason: string) => void>(() => {});
  return (
    <DialogPrimitive.Root
      open={props.open}
      onOpenChange={(next, details) => {
        if (next) return;
        details.cancel();
        dismissRef.current(details.reason);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          data-slot="todo-dialog"
          className="fixed top-[12vh] left-1/2 z-50 w-140 max-w-[calc(100%-2rem)] -translate-x-1/2 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {props.open && (
            <TodoBody {...props} registerDismiss={(fn) => (dismissRef.current = fn)} />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function TodoBody({
  projectId,
  takenSlugs,
  onClose,
  onWrite,
  onDeleteTodo,
  onManagePrompts,
  onManageHarnesses,
  registerDismiss,
}: TodoDialogProps & { registerDismiss: (fn: (reason: string) => void) => void }) {
  const requestDelegation = useMutation(api.chats.requestDelegation);
  // The document model. A fresh capture opens on an empty draft; the ⌘⏎ split
  // writes `title:` into it and the body autosaves from there.
  const draft = useTaskDraft("");

  const [stage, setStage] = useState<Stage>("capture");
  const [armed, setArmed] = useState(false); // discard armed (Decision 4)
  const [transforming, setTransforming] = useState(false);
  const [view, setView] = useState<View>(loadView);

  // The committed file path once materialized (by ⌘⏎ or an early image paste),
  // mirrored in a ref for async handlers that span a write.
  const [committedPath, setCommittedPath] = useState<string | null>(null);
  const committedRef = useRef<string | null>(null);
  const setCommitted = (path: string | null) => {
    committedRef.current = path;
    setCommittedPath(path);
  };
  const slug = committedPath ? taskSlug(committedPath) : null;
  // The last content we persisted, so close only rewrites when the body actually
  // changed (the draft's own dirty baseline is "", so it's always "dirty").
  const lastWrittenRef = useRef<string | null>(null);

  // Backlog order (for the prepend-on-save, Decision "new items land at top").
  const order = useQuery(api.backlogOrders.getBacklogOrder, { projectId }) ?? [];
  const orderRef = useRef<string[]>(order);
  orderRef.current = order;
  const setBacklogOrder = useMutation(
    api.backlogOrders.setBacklogOrder,
  ).withOptimisticUpdate((store, args) => {
    store.setQuery(
      api.backlogOrders.getBacklogOrder,
      { projectId: args.projectId },
      args.order,
    );
  });

  const attachments = useAttachments(
    slug ? { projectId, slug } : undefined,
  );
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const skills = useSkills(projectId);

  const editorRef = useRef<MarkdownEditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const stageRef = useRef(stage);
  stageRef.current = stage;
  const transformingRef = useRef(transforming);
  transformingRef.current = transforming;
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    window.localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  // A committed write that remembers what it wrote, so close can skip a no-op.
  const write = useCallback(
    async (path: string, content: string) => {
      lastWrittenRef.current = content;
      await onWrite(path, content);
    },
    [onWrite],
  );

  async function prependBacklog(path: string) {
    const current = orderRef.current.filter((p) => p !== path);
    await setBacklogOrder({ projectId, order: [path, ...current] });
  }

  // ⌘⏎ in the capture stage: split the first line into `title:` (Decision 2),
  // materialize the file, prepend it to the backlog, and grow the card into the
  // saved stage. Idempotent against the pasted-early case (the file already
  // exists — we just persist the split + prepend). Swallowed while transforming.
  const transform = useCallback(async () => {
    if (transformingRef.current || stageRef.current !== "capture") return;
    const captured = draft.body;
    const already = committedRef.current;
    if (captured.trim() === "" && !already) return; // ⌘⏎ on empty = no-op

    const split = splitCaptureText(captured);
    // A run-on with no first line (leading newline) still deserves a title —
    // fall back to the body's first words, so the saved card never reads "Untitled".
    const title = split.title.trim() || deriveTitleFromBody(split.body);
    draft.setTitle(title);
    draft.setBody(split.body);
    const content = draft.getLatestRaw();

    let path = already;
    if (path) {
      await write(path, content);
    } else {
      path = taskBodyPath(uniqueSlug(title || "task", new Set(takenSlugs)));
      setCommitted(path);
      await write(path, content);
    }
    void prependBacklog(path);

    // Grow the card in place — measure the current height, flip the stage, then
    // animate to the taller layout (see the layout effect below).
    beginGrow();
    setTransforming(true);
    setStage("saved");
    window.setTimeout(() => setTransforming(false), TRANSFORM_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, takenSlugs, write]);

  // ─── Card grow animation (pure vertical growth, same width/left/top) ───────
  // Capture the pre-transform height, then in a layout effect animate height
  // from that to the new content height, settling back to auto.
  const prevHeightRef = useRef<number | null>(null);
  function beginGrow() {
    const el = cardRef.current;
    if (el) prevHeightRef.current = el.getBoundingClientRect().height;
  }
  useLayoutEffect(() => {
    const el = cardRef.current;
    const prev = prevHeightRef.current;
    if (!el || prev == null) return;
    prevHeightRef.current = null;
    const target = el.scrollHeight;
    el.style.height = `${prev}px`;
    void el.offsetHeight; // force reflow so the next height starts the transition
    const id = requestAnimationFrame(() => {
      el.style.height = `${target}px`;
    });
    const done = (e: TransitionEvent) => {
      if (e.propertyName !== "height") return;
      el.style.height = "auto";
      el.removeEventListener("transitionend", done);
    };
    el.addEventListener("transitionend", done);
    return () => {
      cancelAnimationFrame(id);
      el.removeEventListener("transitionend", done);
    };
  }, [stage]);

  // ─── Dismiss policy ────────────────────────────────────────────────────────
  const dismiss = useCallback(
    (_reason: string) => {
      if (stageRef.current === "saved") {
        // The document is saved; esc is free. Persist any body edits, then close.
        const content = draft.getLatestRaw();
        const path = committedRef.current;
        onClose();
        if (path && content !== lastWrittenRef.current) {
          void write(path, content).catch((err) =>
            console.error("Failed to save todo after closing", err),
          );
        }
        return;
      }
      // Capture stage: nothing typed and nothing materialized → close instantly.
      const dirty = draft.body.trim() !== "" || committedRef.current !== null;
      if (!dirty) {
        onClose();
        return;
      }
      // First esc arms a visible destructive footer; second esc discards.
      if (!armed) {
        setArmed(true);
        return;
      }
      const path = committedRef.current;
      onClose();
      if (path) {
        const s = taskSlug(path);
        if (s) {
          void onDeleteTodo(s).catch((err) =>
            console.error("Failed to delete discarded capture", err),
          );
        }
      }
    },
    [armed, draft, onClose, onDeleteTodo, write],
  );

  useEffect(() => {
    registerDismiss(dismiss);
  }, [dismiss, registerDismiss]);

  // Any typing or click disarms the discard guard (Decision 4).
  const disarm = () => {
    if (armed) setArmed(false);
  };

  // ─── Start (delegate) — fire-and-forget (Decision 6) ───────────────────────
  const startChat = useCallback(
    async ({
      harness,
      model,
      effort,
      prompt,
    }: {
      harness: Harness;
      model: string;
      effort: string;
      prompt: string;
    }) => {
      const path = committedRef.current;
      if (!path) return;
      const launchId = crypto.randomUUID();
      const stamped = stampDelegationRequest(
        draft.getLatestRaw(),
        harness,
        launchId,
      );
      const hash = await sha256(stamped);
      const title = draft.title.trim() || taskSlug(path) || "task";
      // Fire the launch and close immediately — the list shows the Requested chip.
      void requestDelegation({
        projectId,
        harness,
        launchId,
        linkedType: "task",
        linkedPath: path,
        content: stamped,
        hash,
        initialPrompt: prompt,
        title,
        model,
        effort,
      }).catch((err) => console.error("Failed to start delegation", err));
      lastWrittenRef.current = stamped;
      onClose();
    },
    [draft, projectId, requestDelegation, onClose],
  );

  // ─── ⋯ menu actions ────────────────────────────────────────────────────────
  function copyPath() {
    if (!committedRef.current) return;
    void navigator.clipboard.writeText(committedRef.current).catch(() => {});
  }
  async function archive() {
    const path = committedRef.current;
    if (!path) return;
    const content = setFrontmatterKeys(draft.getLatestRaw(), {
      "archived-at": new Date().toISOString(),
    });
    onClose();
    await write(path, content).catch((err) =>
      console.error("Failed to archive todo", err),
    );
  }
  function del() {
    const path = committedRef.current;
    onClose();
    if (path) {
      const s = taskSlug(path);
      if (s) void onDeleteTodo(s).catch(() => {});
    }
  }

  // ─── Attachments: image paste / file drop → materialize early, upload ──────
  // Commit (with a provisional title — the ⌘⏎ split overwrites it) so the upload
  // has a task folder, then wait a frame for useAttachments to adopt the slug.
  async function attachmentsForUpload() {
    if (committedRef.current) return attachmentsRef.current;
    const title = draft.title.trim() || deriveTitleFromBody(draft.body) || "task";
    const path = taskBodyPath(uniqueSlug(title, new Set(takenSlugs)));
    const content = setFrontmatterKeys(draft.getLatestRaw(), { title });
    setCommitted(path);
    await write(path, content);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    return attachmentsRef.current;
  }
  function appendToBody(snippets: string[]) {
    if (snippets.length === 0) return;
    const base = draft.body.replace(/\s*$/, "");
    const additions = snippets.join("\n\n");
    draft.setBody(base ? `${base}\n\n${additions}\n` : `${additions}\n`);
    requestAnimationFrame(() => editorRef.current?.focusEnd());
  }
  const onPasteFilesRef = useRef<(files: File[]) => void>(() => {});
  onPasteFilesRef.current = (files: File[]) => {
    void attachmentsForUpload()
      .then((a) => a.uploadPasted(files))
      .then(appendToBody);
  };
  const onDropFilesRef = useRef<(files: File[]) => void>(() => {});
  onDropFilesRef.current = (files: File[]) => {
    void attachmentsForUpload()
      .then((a) => a.uploadDropped(files))
      .then(appendToBody);
  };

  // Native capture-phase listeners so a file paste/drop routes through our one
  // materialize-early path (mirrors TaskDialog). Bound once; read live via refs.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) onDropFilesRef.current(files);
    };
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      const allImages = files.every((f) => f.type.startsWith("image/"));
      // An image-only paste in the formatted editor with a slug already present
      // goes to the editor's own caret-insertion plugin; everything else (no
      // slug yet, raw view, or non-image files) we take and append.
      if (
        viewRef.current === "formatted" &&
        allImages &&
        committedRef.current
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onPasteFilesRef.current(files);
    };
    el.addEventListener("dragover", onOver, true);
    el.addEventListener("drop", onDrop, true);
    el.addEventListener("paste", onPaste, true);
    return () => {
      el.removeEventListener("dragover", onOver, true);
      el.removeEventListener("drop", onDrop, true);
      el.removeEventListener("paste", onPaste, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the body editor when capture opens (an empty capture needs no click).
  useEffect(() => {
    const id = requestAnimationFrame(() => editorRef.current?.focusEnd());
    return () => cancelAnimationFrame(id);
  }, []);

  // ⌘⏎ in the capture stage — a window capture-phase listener so it fires even if
  // the Lexical editor swallows the key. Gated to the capture stage and off
  // during the transform window (Decision 5); the footer owns ⌘⏎ once saved.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key !== "Enter" ||
        !(e.metaKey || e.ctrlKey) ||
        e.shiftKey ||
        e.altKey ||
        e.repeat
      ) {
        return;
      }
      if (stageRef.current !== "capture" || transformingRef.current) return;
      if (document.querySelector('[role="menu"],[role="listbox"]')) return;
      e.preventDefault();
      e.stopPropagation();
      void transform();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [transform]);

  const footerState: TodoFooterState =
    stage === "saved" ? "compose" : armed ? "coaching-armed" : "coaching";
  const displayTitle = draft.frontmatter.title || "Untitled";

  return (
    <div
      ref={rootRef}
      onMouseDownCapture={disarm}
      onKeyDownCapture={(e) => {
        // Any typing disarms the discard guard (Escape drives it, so leave it be).
        if (e.key !== "Escape") disarm();
      }}
    >
      <div
        ref={cardRef}
        className="flex max-h-[76vh] flex-col overflow-hidden rounded-xl border border-[#E4E4E4] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.16)] transition-[height] duration-[250ms] ease-out dark:border-border dark:bg-card"
      >
        {/* ⋯ / ✕ — saved stage only (capture is chrome-free). Above the title. */}
        {stage === "saved" && (
          <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1">
            <Menu>
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label="Todo actions"
                    className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
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
                <MenuItem onClick={() => void archive()}>
                  <ArchiveIcon />
                  Archive
                </MenuItem>
                <div className="my-1 h-px bg-border" />
                <MenuItem
                  onClick={del}
                  className="text-[#B42318] data-highlighted:bg-[#B42318]/10 data-highlighted:text-[#B42318]"
                >
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuContent>
            </Menu>
            <button
              type="button"
              aria-label="Close"
              onClick={() => dismiss("close-press")}
              className="flex size-6.5 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </div>
        )}

        {/* Body — scrolls near the viewport cap; header (title) pinned by being
            first in the flex column with the footer pinned last. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {view === "raw" && stage === "saved" ? (
            <textarea
              ref={rawRef}
              aria-label="Todo content"
              value={draft.raw}
              onChange={(e) => {
                disarm();
                draft.setRaw(e.target.value);
              }}
              spellCheck={false}
              className="hitch-autosize min-h-[180px] w-full shrink-0 resize-none overflow-hidden bg-transparent px-5 pt-10 pb-4 font-mono text-xs leading-relaxed outline-none"
            />
          ) : (
            <div className="flex flex-col px-5">
              {stage === "saved" && (
                <textarea
                  ref={titleRef}
                  aria-label="Todo title"
                  rows={1}
                  value={draft.title}
                  onChange={(e) => {
                    disarm();
                    draft.setTitle(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      editorRef.current?.focusStart();
                    }
                  }}
                  placeholder="Untitled"
                  spellCheck={false}
                  className="hitch-autosize mt-10 mb-2 w-full shrink-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-[18px] font-semibold leading-6 tracking-[-0.01em] text-[#0B0B0B] outline-none placeholder:text-muted-foreground/40 dark:text-foreground"
                />
              )}
              {/* Capture keeps the card tiny: `hitch-capture-compact` lowers the
                  editor's 180px min-height floor to JV0-0's compact proportions
                  (see styles.css); the saved stage is a document and keeps the
                  default. */}
              <div
                className={
                  stage === "capture"
                    ? "hitch-capture-compact pt-5 pb-3"
                    : "pb-4"
                }
              >
                <MarkdownEditor
                  ref={editorRef}
                  value={draft.body}
                  onChange={(v) => {
                    disarm();
                    draft.setBody(v);
                  }}
                  placeholder={
                    stage === "capture"
                      ? "What needs doing?"
                      : "Describe what you're working on, or drop in a screenshot or file"
                  }
                  imageUploadHandler={
                    attachments.enabled
                      ? attachments.imageUploadHandler
                      : undefined
                  }
                  imagePreviewHandler={
                    attachments.enabled
                      ? attachments.imagePreviewHandler
                      : undefined
                  }
                  skills={skills}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer — keyed by the explicit state enum (slice 5 adds more). */}
        {footerState === "compose" ? (
          <TodoDelegateFooter
            projectId={projectId}
            title={displayTitle}
            path={committedPath ?? ""}
            ready={stage === "saved" && !transforming}
            onStart={startChat}
            onManagePrompts={onManagePrompts}
            onManageHarnesses={onManageHarnesses}
          />
        ) : (
          <CoachingFooter armed={footerState === "coaching-armed"} />
        )}
      </div>
    </div>
  );
}

// The stage-1 coaching strip. It's the only place esc is coached, because it's
// the only place esc destroys anything. The armed variant (first esc) turns the
// whole strip destructive so the discard warning can't be missed (Decision 4).
function CoachingFooter({ armed }: { armed: boolean }) {
  if (armed) {
    return (
      <div className="flex items-center justify-between gap-3 border-t border-destructive/25 bg-destructive/8 px-5 py-2.5">
        <span className="text-[12.5px] font-medium text-destructive">
          Discard this capture?
        </span>
        <span className="text-[12px] text-destructive/90">
          Press <Chip tone="destructive">esc</Chip> again to discard · type to
          keep
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end gap-3 border-t border-[#EDEDED] bg-[#F9F9F9] px-5 py-2.5 dark:border-border dark:bg-muted/40">
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Chip>⌘⏎</Chip> Save
      </span>
      <span className="text-[12px] text-muted-foreground/50">·</span>
      <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <Chip>esc</Chip> Cancel
      </span>
    </div>
  );
}

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "destructive";
}) {
  return (
    <kbd
      className={cn(
        "inline-flex items-center rounded-[4px] border px-1.25 py-px font-mono text-[10.5px] leading-none",
        tone === "destructive"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-background text-muted-foreground",
      )}
    >
      {children}
    </kbd>
  );
}

const MANAGE_PROMPTS_VALUE = "__manage_prompts__";

// The docked delegation panel (stage-2 compose). One tinted surface, no internal
// hairlines: preset row over agent row over the black Start button. The compose
// LOGIC is harvested verbatim from DelegationBand (loadLastAgent/saveLastAgent,
// chooseAgent, choosePreset, honorsLaunchParams, the requestDelegation call); the
// chrome is rebuilt to KRN-0 (docked, Start-as-text-button with an embedded ⌘⏎
// chip) rather than DelegationBand's floating up-arrow Send.
function TodoDelegateFooter({
  projectId,
  title,
  path,
  ready,
  onStart,
  onManagePrompts,
  onManageHarnesses,
}: {
  projectId: Id<"projects">;
  title: string;
  path: string;
  // False during the transform window (Decision 5) so ⌘⏎ is swallowed until the
  // card settles.
  ready: boolean;
  onStart: (params: {
    harness: Harness;
    model: string;
    effort: string;
    prompt: string;
  }) => Promise<void> | void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}) {
  const [harness, setHarness] = useState<Harness>(() => loadLastAgent().harness);
  const [model, setModel] = useState(() => loadLastAgent().model);
  const [effort, setEffort] = useState(() => loadLastAgent().effort);
  const [harnessEnvs, setHarnessEnvs] = useState<Record<string, string>>({});
  const [prompts, setPrompts] = useState<StartingPrompt[]>(
    BUILTIN_STARTING_PROMPTS,
  );
  const [promptId, setPromptId] = useState(BUILTIN_STARTING_PROMPTS[0].id);
  const [prompt, setPrompt] = useState(() =>
    buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], { title, path }),
  );
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let active = true;
    void loadCustomPrompts().then((custom) => {
      if (active) setPrompts([...BUILTIN_STARTING_PROMPTS, ...custom]);
    });
    return () => {
      active = false;
    };
  }, []);

  // Refill the preview prompt (its preamble embeds the title + file path).
  useEffect(() => {
    setPromptId(BUILTIN_STARTING_PROMPTS[0].id);
    setPrompt(buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], { title, path }));
  }, [title, path]);

  useEffect(() => {
    const bridge =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              hitchDaemon?: {
                getHarnessEnvironments?: () => Promise<Record<string, string>>;
              };
            }
          ).hitchDaemon
        : undefined;
    if (!bridge?.getHarnessEnvironments) return;
    void bridge
      .getHarnessEnvironments()
      .then((map) => setHarnessEnvs(map ?? {}))
      .catch(() => {});
  }, []);

  function chooseAgent(value: string) {
    const sep = value.indexOf("|");
    const nextHarness = value.slice(0, sep) as Harness;
    const nextModel = value.slice(sep + 1);
    setModel(nextModel);
    if (nextHarness !== harness) setHarness(nextHarness);
    if (nextHarness !== harness || nextModel !== model) {
      setEffort(defaultReasoning(nextHarness, nextModel));
    }
  }

  function choosePreset(id: string) {
    if (id === MANAGE_PROMPTS_VALUE) {
      onManagePrompts?.();
      return;
    }
    const preset = prompts.find((p) => p.id === id);
    if (!preset) return;
    setPromptId(id);
    setPrompt(buildStartPrompt(preset, { title, path }));
  }

  const start = useCallback(async () => {
    if (sending) return;
    setSending(true);
    saveLastAgent({ harness, model, effort });
    // onStart fires the delegation and closes the dialog (fire-and-forget); this
    // component unmounts, so there's no post-close state to reset.
    await onStart({ harness, model, effort, prompt });
  }, [sending, harness, model, effort, prompt, onStart]);

  // ⌘⏎ delegates once the card has settled (Decision 5's re-arm).
  useEffect(() => {
    if (!ready) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Enter" || !e.metaKey || e.shiftKey || e.altKey || e.repeat) {
        return;
      }
      if (
        document.querySelector(
          '[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      void start();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [ready, start]);

  const storedEnv = harnessEnvs[harness];
  const currentEnv: Environment = isEnvironment(storedEnv ?? "")
    ? (storedEnv as Environment)
    : defaultEnvironment(harness);
  const paramsHonored = honorsLaunchParams(harness, currentEnv);

  const chip = "h-7 gap-1.5 border-0 px-1.5 font-normal hover:bg-black/5";

  return (
    <div className="flex flex-col gap-2.5 rounded-b-xl border-t border-t-[#E8E8E8] bg-[#F9F9F9] px-5 pt-3 pb-3.5 dark:border-t-border dark:bg-muted/40">
      {/* Preset row */}
      <div className="flex items-center justify-between gap-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Select
            value={promptId}
            onValueChange={(value) => choosePreset(value as string)}
          >
            <SelectTrigger
              aria-label="Starting prompt"
              className="h-6.5 shrink-0 gap-1 rounded-sm border border-[#DEDEDE] bg-white px-2 text-[12.5px] font-semibold text-[#2E2E2E] hover:bg-white/70 dark:border-border dark:bg-background dark:text-foreground"
            >
              <SelectValue>
                {(value: string) =>
                  prompts.find((p) => p.id === value)?.name ?? "Select a prompt"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {prompts
                .filter((p) => BUILTIN_PROMPT_IDS.has(p.id))
                .map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              {prompts.some((p) => !BUILTIN_PROMPT_IDS.has(p.id)) && (
                <>
                  <div className="my-1 h-px bg-border" />
                  {prompts
                    .filter((p) => !BUILTIN_PROMPT_IDS.has(p.id))
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                </>
              )}
              {onManagePrompts && (
                <>
                  <div className="my-1 h-px bg-border" />
                  <SelectItem
                    value={MANAGE_PROMPTS_VALUE}
                    className="text-muted-foreground"
                  >
                    <Settings2Icon className="size-3.5 shrink-0" />
                    Manage prompts in settings…
                  </SelectItem>
                </>
              )}
            </SelectContent>
          </Select>
          <span className="truncate text-[12.5px] text-[#717171] dark:text-muted-foreground">
            {promptDescription(
              prompts.find((p) => p.id === promptId) ??
                BUILTIN_STARTING_PROMPTS[0],
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse prompt" : "Edit prompt"}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-[#555555] hover:bg-black/5 dark:text-muted-foreground"
        >
          {expanded ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <>
              <PencilIcon className="size-3" />
              Edit
            </>
          )}
        </button>
      </div>

      {/* The one-off editable prompt (never written back to the preset). */}
      {expanded && (
        <textarea
          aria-label="Delegation instructions"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          spellCheck={false}
          rows={6}
          autoFocus
          className="w-full resize-none rounded-md border border-[#E4E4E4] bg-white px-3 py-2 font-mono text-xs leading-relaxed outline-none dark:border-border dark:bg-background"
        />
      )}

      {/* Agent row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Select
            value={`${harness}|${model}`}
            onValueChange={(value) => chooseAgent(value as string)}
          >
            <SelectTrigger aria-label="Agent and model" className={chip}>
              <SelectValue>
                {(value: string) => {
                  const sep = value.indexOf("|");
                  const h = value.slice(0, sep) as Harness;
                  const m = value.slice(sep + 1);
                  return (
                    <span className="flex items-center gap-1.5">
                      <HarnessIcon harness={h} className="size-3.5" />
                      <span className="text-[13px] font-medium text-[#222222] dark:text-foreground">
                        {harnessLabel(h)}
                      </span>
                      <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
                        {modelLabel(h, m)}
                      </span>
                    </span>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {HARNESSES.map((h) => (
                <Fragment key={h}>
                  <div className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
                    <HarnessIcon harness={h} className="size-3.5" />
                    {harnessLabel(h)}
                  </div>
                  {MODELS_BY_HARNESS[h].map((m) => (
                    <SelectItem
                      key={`${h}|${m.id}`}
                      value={`${h}|${m.id}`}
                      className="pl-7"
                    >
                      {m.label}
                    </SelectItem>
                  ))}
                </Fragment>
              ))}
            </SelectContent>
          </Select>

          <span className="h-3.5 w-px shrink-0 bg-[#DEDEDE] dark:bg-border" aria-hidden />

          <Select
            value={effort}
            onValueChange={(value) => setEffort(value as string)}
            disabled={!paramsHonored}
          >
            <SelectTrigger aria-label="Reasoning effort" className={chip}>
              <GaugeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue>
                {(value: string) => (
                  <span className="text-[13px] text-[#717171] dark:text-muted-foreground">
                    {reasoningLabel(harness, value, model)}
                  </span>
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {reasoningOptions(harness, model).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Start — black, text + embedded ⌘⏎ chip (KRN-0). */}
        <button
          type="button"
          onClick={() => void start()}
          disabled={sending}
          aria-label="Start"
          className="flex h-8 shrink-0 items-center gap-1.75 rounded-md bg-[#0B0B0B] px-3 text-white disabled:opacity-70 dark:bg-foreground dark:text-background"
        >
          {sending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <>
              <span className="text-[13px] font-semibold">Start</span>
              <span className="rounded-[4px] border border-white/20 bg-white/15 px-1.25 py-px font-mono text-[10.5px] leading-none text-white/85 dark:border-background/20 dark:bg-background/15 dark:text-background/85">
                ⌘⏎
              </span>
            </>
          )}
        </button>
      </div>

      {!paramsHonored && (
        <p className="text-xs text-amber-600 dark:text-amber-400/90">
          For Claude Code in {environmentLabel(currentEnv)}, model and reasoning
          are set in the editor window.{" "}
          {onManageHarnesses && (
            <button
              type="button"
              onClick={onManageHarnesses}
              className="font-medium underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-300"
            >
              Manage your preferred harness environments here
            </button>
          )}
        </p>
      )}
    </div>
  );
}
