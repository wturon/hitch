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
import { type TodoDialogState } from "./dialogState";
import { dismissAction, shouldSaveOnClose } from "./useDiscardGuard";
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

// The live query row backing a persisted task (Todos v1, slice 5 + the
// single-binding change). In edit mode the dialog seeds its document model from
// `content` and pins `path`, and — critically — keeps FOLLOWING `content` as the
// live query updates it (the daemon's generated title, a chat-link stamp, a
// footer status). `updatedAt` is the row's recency, shown in the linked footer.
// This is App's projection of the `files` row; it is `undefined` in create mode
// until the capture's ⌘⏎ persists the file and App resolves the row.
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
//   • saved — the same card grown downward: the captured text becomes the body
//     verbatim, a seed title (its first ~6 words) is stamped into the slim
//     header row's small muted title input (window chrome, not content — the
//     body stays the card's largest, darkest element), and the coaching strip
//     becomes the docked delegation panel. Start is fire-and-forget. (Capture
//     text is sacred; the title is additive metadata — nothing is ever carved
//     out of the body. See transform.)
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
  // The single source of truth for what the dialog is showing (see dialogState).
  // App mounts ONE TodoDialog and drives it entirely through this union.
  state: TodoDialogState;
  projectId: Id<"projects">;
  // The live query row for an edit-mode (or committed-capture) dialog, resolved
  // by App from the `files` subscription so external writes keep flowing in.
  // `undefined` in create mode until the capture commits — see onCommitted.
  row: ExistingTodo | undefined;
  // Slugs already on disk, so a fresh capture mints a non-colliding one on save.
  takenSlugs: string[];
  // Close the dialog (App resets the union to { mode: "closed" }).
  onClose: () => void;
  // Called after a capture's ⌘⏎ write SUCCEEDS, handing App the persisted path
  // so it transitions create→edit (KEEPING the same session, so this component
  // is not remounted) and starts feeding the live row. Never called from a
  // failed write, and never from an early image-paste materialize — binding
  // starts at SAVE, not at file materialization.
  onCommitted: (path: string) => void;
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
  const { state, row } = props;
  // The dialog is open in create mode always, and in edit mode only while the
  // live row is present — mirroring the old `open={openTodoFile !== undefined}`
  // close-on-vanish semantics for existing todos (App also resets the union to
  // closed via reconcileState, so a vanished row doesn't just hide the dialog
  // but clears the lingering state). A committed capture stays open across the
  // create→edit flip because the row it just wrote resolves immediately.
  const open =
    state.mode === "create" || (state.mode === "edit" && row !== undefined);
  // TodoBody's React key. Minted fresh per open, but PRESERVED across the
  // capture→edit commit (same session), so the transform doesn't remount — the
  // grow animation and Lexical editor state survive. Opening a different todo is
  // a new session, so it does remount fresh. See dialogState.
  const session = state.mode === "closed" ? null : state.session;
  // In edit mode (including a just-committed capture) the body follows the live
  // row; in create mode it runs on a local draft (row is undefined here).
  const existing = state.mode === "edit" ? row : undefined;

  // Route EVERY dismissal (Escape, outside press, the ✕) through the body's
  // save policy. The body registers its handler here; the Dialog stays
  // controlled by `open`, so cancelling the Base UI change just hands the
  // decision to the body.
  const dismissRef = useRef<(reason: string) => void>(() => {});
  return (
    <DialogPrimitive.Root
      open={open}
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
          {open && session !== null && (
            <TodoBody
              // Keyed by the session token, NOT by path: a capture that commits
              // to a path keeps its session, so it does NOT remount (the whole
              // point — the document model quietly re-binds from local draft to
              // live row via the `existing` prop). Opening a different todo is a
              // fresh session and remounts.
              key={session}
              projectId={props.projectId}
              existing={existing}
              takenSlugs={props.takenSlugs}
              onClose={props.onClose}
              onCommitted={props.onCommitted}
              onWrite={props.onWrite}
              onDeleteTodo={props.onDeleteTodo}
              onUserDeleteTodo={props.onUserDeleteTodo}
              onManagePrompts={props.onManagePrompts}
              onManageHarnesses={props.onManageHarnesses}
              registerDismiss={(fn) => (dismissRef.current = fn)}
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// TodoBody's props: the resolved document view, not the raw union. `existing`
// arrives undefined for a fresh capture and flips to the live row on commit
// (same key, no remount); the mount-time initializers below seed once per
// session off whatever `existing` is at mount (undefined = capture).
interface TodoBodyProps {
  projectId: Id<"projects">;
  existing?: ExistingTodo;
  takenSlugs: string[];
  onClose: () => void;
  onCommitted: (path: string) => void;
  onWrite: (path: string, content: string) => Promise<void>;
  onDeleteTodo: (slug: string) => Promise<void>;
  onUserDeleteTodo: (slug: string) => void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
  registerDismiss: (fn: (reason: string) => void) => void;
}

function TodoBody({
  projectId,
  existing,
  takenSlugs,
  onClose,
  onCommitted,
  onWrite,
  onDeleteTodo,
  onUserDeleteTodo,
  onManagePrompts,
  onManageHarnesses,
  registerDismiss,
}: TodoBodyProps) {
  const requestDelegation = useMutation(api.chats.requestDelegation);
  const enqueueGenerateTitle = useMutation(api.commands.enqueueGenerateTitle);
  // "Focus claims ownership" of the title (the seed→generated race guard): once
  // the header's title input has been FOCUSED in this dialog session, title
  // generation forfeits permanently — the draft claims `title`, so the daemon's
  // incoming generated title is never adopted, even into a clean draft (it would
  // swap the text under the user's cursor). The claim keeps the draft dirty, so
  // the close-time save writes the user's/seed title back to disk — which the
  // daemon-side seed guard already tolerates.
  const titleClaimedRef = useRef(false);
  // The document model. Two seeds, chosen once at mount (this component is keyed
  // by session, so mount == a fresh open):
  //   • create — no `existing`, so it restores the localStorage recovery draft
  //     if one exists (else opens empty) and starts in "capture".
  //   • edit   — `existing` is the live row, so it seeds from its file content
  //     and opens straight in "saved".
  // The `content` argument is REACTIVE (useFrontmatterDocument follows it): after
  // a capture commits, App flips `existing` from undefined to the live row, so
  // this same still-mounted body starts receiving the row's content. The first
  // such change (right after the ⌘⏎ write) is a no-op merge — the write already
  // put those exact bytes here — which rebases the dirty baseline; later external
  // writes (the daemon's generated title ~15s on) then adopt cleanly. This is the
  // single source of truth: once persisted, the document follows the live query.
  const draft = useTaskDraft(
    existing?.content ?? loadCaptureDraft(projectId) ?? "",
    { claimedKeys: () => (titleClaimedRef.current ? ["title"] : []) },
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

  // ⌘⏎ in the capture stage: grow the card into the saved stage, then materialize
  // the file and prepend it to the backlog. Idempotent against the pasted-early
  // case (the file already exists — we just persist + prepend). Swallowed while
  // transforming.
  //
  // OPTIMISTIC TRANSITION (why the grow no longer waits on the network): the file
  // write goes through `upsertFile`, whose `withOptimisticUpdate` patches the
  // `listFiles` cache SYNCHRONOUSLY when the mutation is called — so everything
  // the saved stage renders is already local the instant we fire the write. We
  // therefore grow + flip to "saved" IMMEDIATELY and let the write fly in the
  // background; the perceived ⌘⏎→edit-dialog delay was purely this awaited round
  // trip. Two things stay gated on the write actually resolving: the create→edit
  // bind (`onCommitted`) and the recovery-draft cleanup — so a failed write can
  // roll the card back to capture without a half-committed dialog (see catch).
  //
  // Invariant (supersedes Todos v1 Decision 2's "split once at ⌘⏎", which carved
  // the first line into `title:` and left only the remainder as the body — a
  // split mid-sentence mutated what the user wrote): capture text is sacred; the
  // title is additive metadata; nothing is ever moved out of the body. The
  // captured text becomes the body VERBATIM (only CRLFs normalized, so pasted
  // markdown round-trips); the title is a non-destructive seed derived from the
  // body's first words (deriveTitleFromBody), upgraded asynchronously by the
  // generate-title pipeline (PR #71).
  const transform = useCallback(async () => {
    if (transformingRef.current || stageRef.current !== "capture") return;
    const captured = draft.body;
    const already = committedRef.current;
    if (captured.trim() === "" && !already) return; // ⌘⏎ on empty = no-op

    const body = captured.replace(/\r\n/g, "\n");
    const title = deriveTitleFromBody(body);
    draft.setTitle(title);
    draft.setBody(body);
    const content = draft.getLatestRaw();

    const path =
      already ?? taskBodyPath(uniqueSlug(title || "task", new Set(takenSlugs)));
    setCommitted(path);

    // Flip to the saved stage NOW, before the write — the optimistic file cache
    // already backs it (see header comment). Mirror the transforming guard into
    // its ref synchronously too, so a second ⌘⏎ landing before this render can't
    // re-enter transform while the write is in flight. Measure the capture height
    // first (FLIP first-rect), then flip the stage so the layout effect animates.
    beginGrow();
    transformingRef.current = true;
    setTransforming(true);
    setStage("saved");
    window.setTimeout(() => setTransforming(false), TRANSFORM_MS);

    try {
      await write(path, content);
    } catch (err) {
      // The write never landed (offline, a rejected mutation): undo the
      // optimistic transition and drop back to capture so the user can retry.
      // The in-memory draft still holds the text — stash it to localStorage too
      // in case they dismiss. Crucially `onCommitted` was NOT called, so App is
      // still in create mode: it never bound to a phantom row, so there's no
      // reconcile-close race to fight here.
      console.error("Failed to materialize todo on ⌘⏎", err);
      setCommitted(already ?? null);
      transformingRef.current = false;
      setTransforming(false);
      setStage("capture");
      saveCaptureDraft(projectId, body);
      return;
    }

    // The write landed. Prepend to the backlog and seed the auto-title pipeline.
    void prependBacklog(path);
    // Seed-then-upgrade auto-title: hand the daemon the seed so it can propose a
    // better one. EVERY capture with content enqueues now (the old empty-body
    // skip is obsolete): the body always holds the full captured text, so a
    // one-liner's words live there — rewriting the title never loses anything.
    // Fire-and-forget: a failed enqueue must never touch the save path.
    if (body.trim() !== "") {
      void enqueueGenerateTitle({ projectId, path, title }).catch((err) =>
        console.error("Failed to enqueue title generation", err),
      );
    }
    // The capture succeeded — the recovery draft's job is done.
    clearCaptureDraft(projectId);

    // Bind to the live query row now that the write has persisted. App flips its
    // union create→edit(path) KEEPING the same session, so this component is NOT
    // remounted — the grow animation and Lexical state survive — and `existing`
    // arrives so the document model starts following the live row. This is the
    // moment the fork ends: from here the document has exactly one source of
    // truth. The incoming row's content equals what we just wrote, so the merge
    // is a no-op that quietly rebases the dirty baseline (see TodoBody seed doc).
    onCommitted(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draft,
    takenSlugs,
    write,
    beginGrow,
    projectId,
    enqueueGenerateTitle,
    onCommitted,
  ]);

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
          // The write gate (shouldSaveOnClose) also fires when the draft is
          // dirty against the LIVE row even though it matches our own last
          // write — the claimed-title case, where the daemon's generated title
          // is on disk and the kept seed must be written back over it.
          const content = draft.getLatestRaw();
          const path = committedRef.current;
          onClose();
          if (
            path &&
            shouldSaveOnClose({
              dirty: draft.dirty,
              latest: content,
              lastWritten: lastWrittenRef.current,
            })
          ) {
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
  //
  // Binding boundary: this writes a provisional file WITHOUT leaving the capture
  // stage, and esc deletes that dir (dismiss "close"). So it deliberately does
  // NOT call onCommitted — binding to the live query starts at SAVE (transform),
  // not at file materialization. A provisionally materialized capture is still a
  // draft: it may be discarded whole on esc. onCommitted fires only on the ⌘⏎
  // that promotes the draft into a persisted document.
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
        {/* Header row — saved stage only (capture is chrome-free). The title is
            machine-generated metadata (a seed upgraded ~5s later by the daemon's
            generate-title pipeline), so it's presented as window chrome: small,
            muted, single-line, inline with the ⋯/✕ — the BODY is the card's
            largest, darkest element. The seed→generated swap is a quiet in-place
            value change, no transition. In the raw view the title is edited
            inside the raw text, so the input yields to a spacer (two controlled
            editors of the same key on screen would be confusing) and only ⋯/✕
            remain, right-aligned. */}
        {stage === "saved" && (
          <div className="flex items-center gap-2 pt-2.5 pr-2.5 pl-5">
            {view === "raw" ? (
              <div className="flex-1" />
            ) : (
              <input
                aria-label="Todo title"
                value={draft.title}
                onChange={(e) => draft.setTitle(e.target.value)}
                // Focus claims the title for this session (see titleClaimedRef):
                // from here on the daemon's generated title is never adopted.
                onFocus={() => (titleClaimedRef.current = true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    editorRef.current?.focusStart();
                  }
                }}
                placeholder="Untitled"
                spellCheck={false}
                className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-[13px] font-medium leading-4 text-muted-foreground outline-none transition-colors hover:text-foreground focus:text-foreground placeholder:text-muted-foreground/40"
              />
            )}
            <SavedActions
              view={view}
              onToggleView={() => setView(view === "raw" ? "formatted" : "raw")}
              onCopyPath={copyPath}
              // Detach shows only when there's a chat or a request to detach.
              onDetach={
                draft.chat || draft.request
                  ? () => void detachChat()
                  : undefined
              }
              onArchive={() => void archive()}
              onDelete={del}
              onClose={() => dismiss("close-press")}
            />
          </div>
        )}

        <TodoEditorArea
          stage={stage}
          view={view}
          draft={draft}
          editorRef={editorRef}
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
