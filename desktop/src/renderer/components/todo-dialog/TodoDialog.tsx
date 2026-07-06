"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";

import {
  BUILTIN_STARTING_PROMPTS,
  MODELS_BY_HARNESS,
  buildStartPrompt,
  defaultReasoning,
  loadLastAgent,
  stampDelegationRequest,
  type Harness,
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
import { prependBacklogPath } from "@/lib/todos";
import { useTaskDraft } from "@/hooks/useTaskDraft";
import { useAttachments } from "@/hooks/useAttachments";
import { useSkills } from "@/hooks/useSkills";
import type { MarkdownEditorHandle } from "@/editor";

import { CaptureFooter } from "./CaptureFooter";
import { SavedActions } from "./SavedActions";
import { TodoDelegateFooter } from "./TodoDelegateFooter";
import { TodoLinkedFooter, TodoRequestFooter } from "./TodoChatFooter";
import { TodoEditorArea } from "./TodoEditorArea";
import {
  clearCaptureDraft,
  loadCaptureDraft,
  saveCaptureDraft,
} from "./captureDraft";
import { selectSavedFooterState } from "./footerState";
import { useCaptureAttachments } from "./useCaptureAttachments";
import { dismissAction } from "./useDiscardGuard";
import { useGrowAnimation } from "./useGrowAnimation";

// A compact "last activity" stamp for the linked footer's status line — bare
// under an hour ("4m ago"), then coarsens. Mirrors TodosView's cadence so a
// todo reads the same recency in the list and in the dialog.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 14 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// A todo already on disk, opened directly into the saved stage (slice 5). The
// dialog seeds its document model from `content` and pins `path`; `updatedAt` is
// the files row's recency, shown in the linked footer's status line.
export interface ExistingTodo {
  path: string;
  content: string;
  updatedAt: number;
}

// The two-stage create dialog for the Todos tab (Todos v1, slice 4). One
// component, two stages, transformed IN PLACE:
//   • capture — a chrome-free 560px card, body-only editor. Nothing exists
//     anywhere until ⌘⏎ (except a pasted image, which materializes the task dir
//     early and is deleted on esc — Decision 3). ⏎ newline · ⌘⏎ save · esc closes
//     instantly; any typed text is preserved as a recovery draft (see
//     captureDraft.ts) rather than guarded behind a second esc.
//   • saved — the same card grown downward: the captured first line crystallizes
//     into the 18px title, the body becomes a document, and the coaching strip
//     becomes the docked delegation panel. Start is fire-and-forget.
//
// This shell owns the single `stage` state (the PRD's one-component contract),
// the esc/dismiss routing, and the transform orchestration; the pieces live
// beside it in this directory — TodoEditorArea (document area), CaptureFooter
// (coaching strip), SavedActions (⋯/✕), TodoDelegateFooter (docked compose
// chrome over the shared useDelegationComposer), and the useGrowAnimation /
// useCaptureAttachments hooks. captureDraft.ts holds the capture-stage
// localStorage recovery draft (Decision 4 amendment).
//
// The footer render is keyed by explicit state (not booleans): the capture stage
// owns "coaching" (CaptureFooter); the saved stage's footer is chosen by
// selectSavedFooterState (compose / linked / requested / failed /
// linked-completed / none) off the draft's chat/request/completed state, so an
// existing todo opens on the right band (slice 5).
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
  // When set, the dialog opens an EXISTING todo directly in the saved stage on
  // this file (slice 5). Absent = a fresh two-stage capture (slice 4).
  existing?: ExistingTodo;
  // Slugs already on disk, so a fresh capture mints a non-colliding one on save.
  takenSlugs: string[];
  // Close the dialog (the parent owns the `open` flag).
  onClose: () => void;
  // Optimistic upsert by path+content — used for the materialize on ⌘⏎, the
  // early materialize on image paste, and body autosave on close.
  onWrite: (path: string, content: string) => Promise<void>;
  // Silent cascade-delete of a task folder (attachments + task.md tombstone).
  // Used only for the discard-cleanup of a pasted-early draft (Decision 3) — an
  // intentional throwaway, so no undo toast.
  onDeleteTodo: (slug: string) => Promise<void>;
  // The ⋯ Delete action: same delete, but a deliberate user gesture, so it goes
  // through the undo-toast path.
  onUserDeleteTodo: (slug: string) => void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}

export function TodoDialog(props: TodoDialogProps) {
  // Route EVERY dismissal (Escape, outside press, the ✕) through the body's
  // save policy. The body registers its handler here; the Dialog stays
  // controlled by `open`, so cancelling the Base UI change just hands the
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
        {/* data-closed:fill-mode-forwards holds the exit fade at 0 — the
            backdrop's 100ms animation ends before the popup's 150ms one, and
            Base UI unmounts the portal only when the popup settles; without it
            the backdrop snaps back to full tint+blur for that gap (the close
            "flash"). */}
        <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:fill-mode-forwards" />
        <DialogPrimitive.Popup
          data-slot="todo-dialog"
          className="fixed top-[12vh] left-1/2 z-50 w-140 max-w-[calc(100%-2rem)] -translate-x-1/2 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {props.open && (
            <TodoBody
              // Keyed so opening a different existing todo remounts fresh — the
              // document model seeds from `content` once (useFrontmatterDocument).
              key={props.existing?.path ?? "capture"}
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
  existing,
  takenSlugs,
  onClose,
  onWrite,
  onDeleteTodo,
  onUserDeleteTodo,
  onManagePrompts,
  onManageHarnesses,
  registerDismiss,
}: TodoDialogProps & {
  registerDismiss: (fn: (reason: string) => void) => void;
}) {
  const requestDelegation = useMutation(api.chats.requestDelegation);
  // The document model. A fresh capture restores its localStorage recovery
  // draft if one exists (else opens empty); an existing todo (slice 5) seeds
  // from its file content and opens straight in "saved".
  const draft = useTaskDraft(
    existing?.content ?? loadCaptureDraft(projectId) ?? "",
  );

  const [stage, setStage] = useState<Stage>(existing ? "saved" : "capture");
  const [transforming, setTransforming] = useState(false);
  const [view, setView] = useState<View>(loadView);

  // The committed file path once materialized (by ⌘⏎ or an early image paste),
  // or the existing todo's path from the start. Mirrored in a ref for async
  // handlers that span a write.
  const [committedPath, setCommittedPath] = useState<string | null>(
    existing?.path ?? null,
  );
  const committedRef = useRef<string | null>(existing?.path ?? null);
  const setCommitted = (path: string | null) => {
    committedRef.current = path;
    setCommittedPath(path);
  };
  const slug = committedPath ? taskSlug(committedPath) : null;
  // The last content we persisted, so close only rewrites when the body actually
  // changed. A fresh capture starts null (draft baseline is "", always "dirty");
  // an existing todo starts at its on-disk content, so a no-op close skips a write.
  const lastWrittenRef = useRef<string | null>(existing?.content ?? null);

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
    await setBacklogOrder({
      projectId,
      order: prependBacklogPath(orderRef.current, path),
    });
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
    // The capture succeeded — the recovery draft's job is done.
    clearCaptureDraft(projectId);

    // Grow the card in place — measure the current height, flip the stage, then
    // animate to the taller layout (useGrowAnimation's layout effect).
    beginGrow();
    setTransforming(true);
    setStage("saved");
    window.setTimeout(() => setTransforming(false), TRANSFORM_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, takenSlugs, write, beginGrow, projectId]);

  // ─── Dismiss policy — the pure decision lives in dismissAction ─────────────
  // Capture-stage esc now ALWAYS closes instantly (Decision 4 amendment — the
  // double-esc "armed" guard is gone). Two things still happen on the way out:
  // the typed body is stashed as a recovery draft (or the draft is cleared if
  // the capture is empty), and a task dir materialized early by an image paste
  // is still deleted (Decision 3 is unchanged — esc always discards it).
  const dismiss = useCallback(
    (_reason: string) => {
      const action = dismissAction({ stage: stageRef.current });
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
        case "close": {
          saveCaptureDraft(projectId, draft.body);
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
    [draft, onClose, onDeleteTodo, projectId, write],
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
      if (s) onUserDeleteTodo(s);
    }
  }

  // Detach chat (⋯ menu) / Cancel request (requested footer): strip every chat-*
  // frontmatter key including the request flag (clearChat → clearChatFields), so
  // the todo derives back to Backlog. The dialog stays open on the compose
  // footer (no chat, no request) — the user can re-delegate or close.
  async function detachChat() {
    const path = committedRef.current;
    if (!path) return;
    const cleared = draft.clearChat();
    await write(path, cleared).catch((err) =>
      console.error("Failed to detach chat", err),
    );
  }

  // Retry (failed footer, ⌘⏎): re-fire the delegation. The original launch
  // params aren't recoverable (only the harness is stamped in the request), so
  // retry reuses the failed request's harness with the user's last-agent model/
  // effort (or that harness's defaults) and the default starting prompt. Like
  // any Start it's fire-and-forget and closes the dialog (Decision 6).
  function retryRequest() {
    const req = draft.request;
    const path = committedRef.current;
    if (!req || !path) return;
    const last = loadLastAgent();
    const harness = req.harness;
    const models = MODELS_BY_HARNESS[harness];
    const model = models.some((m) => m.id === last.model)
      ? last.model
      : models[0].id;
    const effort =
      last.harness === harness ? last.effort : defaultReasoning(harness, model);
    const title = draft.title.trim() || taskSlug(path) || "task";
    const prompt = buildStartPrompt(BUILTIN_STARTING_PROMPTS[0], {
      title,
      path,
    });
    void startChat({ harness, model, effort, prompt });
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

  // The saved-stage footer band (compose / linked / requested / failed /
  // linked-completed / none), chosen off the live draft. `completed-at` is the
  // canonical timestamp (slice 6b retired the legacy `status:` model). Only
  // meaningful once `stage === "saved"`.
  const completed = (draft.frontmatter["completed-at"] ?? "").trim() !== "";
  const savedFooter = selectSavedFooterState({
    hasChat: draft.chat !== null,
    request: draft.request,
    completed,
  });
  // ⌘⏎ arms the saved-stage footers only once the card has settled (existing
  // todos open settled; a capture→saved transform re-arms after ~250ms).
  const footerReady = stage === "saved" && !transforming;
  const displayTitle = draft.frontmatter.title || "Untitled";
  const footerTitle = draft.frontmatter.title || slug || "Untitled";
  const linkedWhen = relativeTime(existing?.updatedAt ?? Date.now());

  return (
    <div ref={rootRef}>
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
            // Detach shows only when there's a chat or a request to detach.
            onDetach={
              draft.chat || draft.request ? () => void detachChat() : undefined
            }
            onArchive={() => void archive()}
            onDelete={del}
            onClose={() => dismiss("close-press")}
          />
        )}

        <TodoEditorArea
          stage={stage}
          view={view}
          draft={draft}
          editorRef={editorRef}
          titleRef={titleRef}
          rawRef={rawRef}
          attachments={attachments}
          skills={skills}
        />

        {/* Footer — capture coaching strip, or the saved-stage band chosen by
            selectSavedFooterState off the draft's chat/request/completed state. */}
        {stage === "capture" ? (
          <CaptureFooter />
        ) : savedFooter === "linked" || savedFooter === "linked-completed" ? (
          draft.chat && (
            <TodoLinkedFooter
              chat={draft.chat}
              chatStatus={draft.chatStatus}
              title={footerTitle}
              when={linkedWhen}
              projectId={projectId}
              ready={footerReady}
              ghostChip={savedFooter === "linked-completed"}
            />
          )
        ) : savedFooter === "requested" || savedFooter === "failed" ? (
          draft.request && (
            <TodoRequestFooter
              request={draft.request}
              ready={footerReady}
              onCancel={() => void detachChat()}
              onRetry={retryRequest}
            />
          )
        ) : savedFooter === "none" ? null : (
          <TodoDelegateFooter
            title={displayTitle}
            path={committedPath ?? ""}
            ready={footerReady}
            onStart={startChat}
            onManagePrompts={onManagePrompts}
            onManageHarnesses={onManageHarnesses}
          />
        )}
      </div>
    </div>
  );
}
