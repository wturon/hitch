"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

import { stampDelegationRequest, type Harness } from "@/lib/chat";
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
import type { MarkdownEditorHandle } from "@/editor";

import { CaptureFooter } from "./CaptureFooter";
import { SavedActions } from "./SavedActions";
import { TodoDelegateFooter } from "./TodoDelegateFooter";
import { TodoEditorArea } from "./TodoEditorArea";
import { useCaptureAttachments } from "./useCaptureAttachments";
import { dismissAction, useDiscardGuard } from "./useDiscardGuard";
import { useGrowAnimation } from "./useGrowAnimation";

// The two-stage create dialog for the Todos tab (Todos v1, slice 4). One
// component, two stages, transformed IN PLACE:
//   • capture — a chrome-free 560px card, body-only editor. Nothing exists
//     anywhere until ⌘⏎ (except a pasted image, which materializes the task dir
//     early and is deleted on discard). ⏎ newline · ⌘⏎ save · esc cancel.
//   • saved — the same card grown downward: the captured first line crystallizes
//     into the 18px title, the body becomes a document, and the coaching strip
//     becomes the docked delegation panel. Start is fire-and-forget.
//
// This shell owns the single `stage` state (the PRD's one-component contract),
// the esc/dismiss routing, and the transform orchestration; the pieces live
// beside it in this directory — TodoEditorArea (document area), CaptureFooter
// (coaching strip + armed variant), SavedActions (⋯/✕), TodoDelegateFooter
// (docked compose chrome over the shared useDelegationComposer), and the
// useDiscardGuard / useGrowAnimation / useCaptureAttachments hooks.
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
            <TodoBody
              {...props}
              registerDismiss={(fn) => (dismissRef.current = fn)}
            />
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
}: TodoDialogProps & {
  registerDismiss: (fn: (reason: string) => void) => void;
}) {
  const requestDelegation = useMutation(api.chats.requestDelegation);
  // The document model. A fresh capture opens on an empty draft; the ⌘⏎ split
  // writes `title:` into it and the body autosaves from there.
  const draft = useTaskDraft("");

  const [stage, setStage] = useState<Stage>("capture");
  const guard = useDiscardGuard(); // the esc discard machine (Decision 4)
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

  const attachments = useAttachments(slug ? { projectId, slug } : undefined);
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

  // The capture→saved grow (FLIP on the card's height; see useGrowAnimation).
  const beginGrow = useGrowAnimation(cardRef, stage);

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
    // animate to the taller layout (useGrowAnimation's layout effect).
    beginGrow();
    setTransforming(true);
    setStage("saved");
    window.setTimeout(() => setTransforming(false), TRANSFORM_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, takenSlugs, write, beginGrow]);

  // ─── Dismiss policy — the pure decision lives in dismissAction ─────────────
  const dismiss = useCallback(
    (_reason: string) => {
      const action = dismissAction({
        stage: stageRef.current,
        dirty: draft.body.trim() !== "" || committedRef.current !== null,
        armed: guard.armed,
      });
      switch (action) {
        case "save-and-close": {
          // The document is saved; esc is free. Persist body edits, then close.
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
        case "close":
          onClose();
          return;
        case "arm":
          guard.arm();
          return;
        case "discard": {
          // Nothing survives esc-esc — including a dir materialized early by an
          // image paste (Decision 3).
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
          return;
        }
      }
    },
    [guard, draft, onClose, onDeleteTodo, write],
  );

  useEffect(() => {
    registerDismiss(dismiss);
  }, [dismiss, registerDismiss]);

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

  // File paste/drop → materialize early + upload (Decision 3). The provisional
  // title commit stays here (it owns slug minting + the optimistic write); the
  // listener plumbing lives in the hook.
  useCaptureAttachments({
    rootRef,
    draft,
    editorRef,
    viewRef,
    committedRef,
    attachmentsRef,
    materializeEarly: async () => {
      const title =
        draft.title.trim() || deriveTitleFromBody(draft.body) || "task";
      const path = taskBodyPath(uniqueSlug(title, new Set(takenSlugs)));
      const content = setFrontmatterKeys(draft.getLatestRaw(), { title });
      setCommitted(path);
      await write(path, content);
    },
  });

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
    stage === "saved" ? "compose" : guard.armed ? "coaching-armed" : "coaching";
  const displayTitle = draft.frontmatter.title || "Untitled";

  return (
    <div
      ref={rootRef}
      onMouseDownCapture={guard.disarm}
      onKeyDownCapture={(e) => {
        // Any typing disarms the discard guard (Escape drives it, so leave it be).
        if (e.key !== "Escape") guard.disarm();
      }}
    >
      <div
        ref={cardRef}
        className="flex max-h-[76vh] flex-col overflow-hidden rounded-xl border border-[#E4E4E4] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.16)] transition-[height] duration-[250ms] ease-out dark:border-border dark:bg-card"
      >
        {/* ⋯ / ✕ — saved stage only (capture is chrome-free). Above the title. */}
        {stage === "saved" && (
          <SavedActions
            view={view}
            onToggleView={() => setView(view === "raw" ? "formatted" : "raw")}
            onCopyPath={copyPath}
            onArchive={() => void archive()}
            onDelete={del}
            onClose={() => dismiss("close-press")}
          />
        )}

        <TodoEditorArea
          stage={stage}
          view={view}
          draft={draft}
          disarm={guard.disarm}
          editorRef={editorRef}
          titleRef={titleRef}
          rawRef={rawRef}
          attachments={attachments}
          skills={skills}
        />

        {/* Footer — keyed by the explicit state enum (slice 5 adds more). */}
        {footerState === "compose" ? (
          <TodoDelegateFooter
            title={displayTitle}
            path={committedPath ?? ""}
            ready={stage === "saved" && !transforming}
            onStart={startChat}
            onManagePrompts={onManagePrompts}
            onManageHarnesses={onManageHarnesses}
          />
        ) : (
          <CaptureFooter armed={footerState === "coaching-armed"} />
        )}
      </div>
    </div>
  );
}
