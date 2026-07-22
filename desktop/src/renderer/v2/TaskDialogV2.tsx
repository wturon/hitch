import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";

import { CaptureFooter } from "@/components/todo-dialog/CaptureFooter";
import { useGrowAnimation } from "@/components/todo-dialog/useGrowAnimation";
import { MarkdownEditor, type MarkdownEditorHandle } from "@/editor";
import type { HitchClient } from "@/lib/server/client";
import { normalizeCaptureBody, captureSeedTitle, captureSortOrder } from "./capture";
import {
  clearCaptureDraft,
  loadCaptureDraft,
  saveCaptureDraft,
} from "./captureDraft";
import { type TaskDialogState } from "./taskDialogState";
import { useTaskDocument, type TaskDocumentFields } from "./useTaskDocument";

// The V2 task dialog (M2 PR 3): capture + edit over server task rows, porting
// V1's TodoDialog architecture (the two-stage card, the single-binding union,
// the esc/dismiss routing) without its file model. One component, two stages,
// transformed IN PLACE:
//
//   • capture — a chrome-free card, body-only MarkdownEditor. Nothing exists
//     on the server until ⌘⏎; esc closes instantly and any typed text is
//     preserved as a per-project localStorage recovery draft (captureDraft).
//     ⌘⏎ creates the task: title = seed derived from the body (LLM auto-title
//     is dropped in V2 — adopted decision), body VERBATIM (capture text is
//     sacred; only CRLFs normalized), sortOrder prepended before the backlog
//     head. The card grows into the saved stage via V1's FLIP hook
//     (useGrowAnimation, imported — it's pure React), fired optimistically
//     before the POST resolves; a failed POST rolls back to capture.
//   • saved — the same card grown downward: slim header row (small muted
//     title input + ✕) over the body editor. The document runs on
//     useTaskDocument bound to the live query row: ~1.5s idle autosave,
//     save-on-close, last-write-wins.
//
// Deliberately absent vs V1 (M4-or-later): the delegation footer band, the ⋯
// menu (mark done / archive / delete are PR 4 list mutations), the raw view,
// the auto-title spinner, skills/snippets in the `/` menu. Seams for the next
// PRs: the tag lane slots between the header row and the editor (PR 5); the
// editor's imageUploadHandler/imagePreviewHandler props take attachments
// (PR 6).
type Stage = "capture" | "saved";

// How long ⌘⏎ is swallowed after the capture→saved transform kicks off, so a
// double-tap can't re-enter the transform (V1 Decision 5).
const TRANSFORM_MS = 260;

// The live-row projection the dialog needs from the tasks list query.
export interface TaskDialogRow extends TaskDocumentFields {
  id: string;
}

export interface TaskDialogV2Props {
  // The single source of truth for what the dialog shows (see taskDialogState).
  // The V2 shell mounts ONE TaskDialogV2 and drives it through this union.
  state: TaskDialogState;
  client: HitchClient;
  projectId: string;
  // The live query row for an edit-mode (or committed-capture) dialog,
  // resolved by the shell from the tasks list query so external writes keep
  // flowing in. `undefined` in capture mode until the ⌘⏎ POST commits.
  row: TaskDialogRow | undefined;
  // The current backlog in list order, so a capture's sortOrder prepends
  // before the head.
  backlog: ReadonlyArray<{ sortOrder: string }>;
  // Close the dialog (the shell resets the union to closed).
  onClose: () => void;
  // Called after a capture's ⌘⏎ POST SUCCEEDS, handing the shell the new task
  // id so it transitions capture→edit KEEPING the same session (no remount)
  // and starts feeding the live row. Never called from a failed POST.
  onCommitted: (taskId: string) => void;
}

export function TaskDialogV2(props: TaskDialogV2Props) {
  const { state, row } = props;
  // Open in capture mode always; in edit mode only while the live row is
  // present (close-on-vanish semantics — the shell also resets the union via
  // reconcileTaskDialog). A committed capture stays open across the
  // capture→edit flip because the row it just posted resolves immediately.
  const open =
    state.mode === "capture" || (state.mode === "edit" && row !== undefined);
  // The body's React key: minted fresh per open, PRESERVED across the
  // capture→edit commit (same session) so the transform doesn't remount — the
  // grow animation and Lexical editor state survive. See taskDialogState.
  const session = state.mode === "closed" ? null : state.session;
  const existing = state.mode === "edit" ? row : undefined;

  // Route EVERY dismissal (Escape, outside press, the ✕) through the body's
  // save policy. The Dialog stays controlled by `open`; cancelling the Base UI
  // change hands the decision to the body.
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
        {/* data-closed:fill-mode-forwards holds the exit fade at 0 so the
            backdrop doesn't flash back to full tint while the popup's longer
            close animation settles (see V1 TodoDialog). */}
        <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:fill-mode-forwards" />
        <DialogPrimitive.Popup
          data-slot="task-dialog-v2"
          className="fixed top-[12vh] left-1/2 z-50 w-140 max-w-[calc(100%-2rem)] -translate-x-1/2 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          {open && session !== null && (
            <TaskBodyV2
              // Keyed by the session token, NOT by task id: a capture that
              // commits keeps its session, so it does NOT remount — the
              // document model quietly re-binds from local draft to live row
              // via the `existing` prop. Opening a different task is a fresh
              // session and remounts.
              key={session}
              client={props.client}
              projectId={props.projectId}
              existing={existing}
              backlog={props.backlog}
              onClose={props.onClose}
              onCommitted={props.onCommitted}
              registerDismiss={(fn) => (dismissRef.current = fn)}
            />
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// The body's props: the resolved document view, not the raw union. `existing`
// arrives undefined for a fresh capture and flips to the live row on commit
// (same key, no remount); the mount-time initializers seed once per session
// off whatever `existing` is at mount (undefined = capture).
interface TaskBodyV2Props {
  client: HitchClient;
  projectId: string;
  existing?: TaskDialogRow;
  backlog: ReadonlyArray<{ sortOrder: string }>;
  onClose: () => void;
  onCommitted: (taskId: string) => void;
  registerDismiss: (fn: (reason: string) => void) => void;
}

function TaskBodyV2({
  client,
  projectId,
  existing,
  backlog,
  onClose,
  onCommitted,
  registerDismiss,
}: TaskBodyV2Props) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<Stage>(existing ? "saved" : "capture");

  const stageRef = useRef(stage);
  stageRef.current = stage;
  // The ⌘⏎-swallow window around the transform. Nothing renders off it (V2 has
  // no saved-stage footer to arm yet), so a ref suffices — no state.
  const transformingRef = useRef(false);
  const backlogRef = useRef(backlog);
  backlogRef.current = backlog;
  // The committed task id (from ⌘⏎, or the existing row from the start),
  // mirrored in a ref for the async persist/transform handlers.
  const taskIdRef = useRef<string | null>(existing?.id ?? null);

  const editorRef = useRef<MarkdownEditorHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // PATCH the dirty fields to the server — last-write-wins, body VERBATIM
  // (routes/tasks.ts passes it through untouched). The tasks invalidation
  // keeps the list + our own row fresh even without the WS round trip. The
  // server rejects an empty title (min 1), so a cleared title persists as
  // "Untitled" — the same word the input shows as its placeholder.
  const persist = useCallback(
    async (patch: Partial<TaskDocumentFields>) => {
      const id = taskIdRef.current;
      if (!id) return;
      const json =
        patch.title !== undefined && patch.title.trim() === ""
          ? { ...patch, title: "Untitled" }
          : patch;
      const response = await client.tasks[":id"].$patch({ param: { id }, json });
      if (!response.ok) throw new Error(`Failed to save task (${response.status})`);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    [client, queryClient],
  );

  // The document model. Two seeds, chosen once at mount (keyed by session, so
  // mount == a fresh open): capture restores the localStorage recovery draft
  // (else opens empty); edit seeds from the live row. The row fields are
  // REACTIVE: after a capture commits, the shell flips `existing` from
  // undefined to the live row, and the first arrival is a pure rebase — the
  // POST already put those exact bytes there. From that moment the row is the
  // document's single source of truth; useTaskDocument's per-field byte-compare
  // keeps a dirty field's local value (so autosave echoes and WS refetches
  // never reset the Lexical editor mid-type) and adopts external values into
  // clean fields.
  // Read the recovery draft once per session (the body is keyed by session,
  // so mount == a fresh open) — not on every keystroke render.
  const [initialDraft] = useState<TaskDocumentFields>(() => ({
    title: "",
    body: loadCaptureDraft(projectId) ?? "",
  }));
  const doc = useTaskDocument({
    row: existing ? { title: existing.title, body: existing.body } : undefined,
    initial: initialDraft,
    persist,
  });
  const docRef = useRef(doc);
  docRef.current = doc;

  // The capture→saved grow (FLIP on the card's height; V1's hook, imported).
  const beginGrow = useGrowAnimation(cardRef, stage);

  // ⌘⏎ in the capture stage: grow the card into the saved stage, then POST the
  // task. The flip is OPTIMISTIC (V1's decision): the grow + stage change fire
  // immediately and the POST flies in the background; only the capture→edit
  // bind (onCommitted) and the recovery-draft cleanup wait for it, so a failed
  // POST rolls the card back to capture with the text intact.
  //
  // Invariant: capture text is sacred. The captured text becomes the body
  // VERBATIM (only CRLFs normalized); the title is a non-destructive seed from
  // the body's first words. Nothing is ever moved out of the body.
  const transform = useCallback(async () => {
    if (transformingRef.current || stageRef.current !== "capture") return;
    const captured = docRef.current.body;
    if (captured.trim() === "") return; // ⌘⏎ on empty = no-op

    const body = normalizeCaptureBody(captured);
    const title = captureSeedTitle(body);
    docRef.current.setTitle(title);
    if (body !== captured) docRef.current.setBody(body);

    beginGrow();
    transformingRef.current = true;
    setStage("saved");
    window.setTimeout(() => {
      transformingRef.current = false;
    }, TRANSFORM_MS);

    try {
      const response = await client.tasks.$post({
        json: {
          projectId,
          title,
          body,
          sortOrder: captureSortOrder(backlogRef.current),
        },
      });
      if (!response.ok) throw new Error(`Failed to create task (${response.status})`);
      const task = await response.json();
      taskIdRef.current = task.id;
      // The POST landed — the recovery draft's job is done.
      clearCaptureDraft(projectId);
      // Optimistically append the created row to the tasks cache BEFORE the
      // union flips to edit mode: the shell resolves the dialog's live row
      // from this query, and without the row present synchronously the flip
      // would trip close-on-vanish while the refetch is still in flight
      // (V1's upsert had the same optimistic-cache guarantee). The refetch
      // then replaces the list wholesale with server truth.
      queryClient.setQueryData(
        ["tasks", { projectId }],
        (old: unknown) => (Array.isArray(old) ? [...old, task] : [task]),
      );
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      // Bind to the live query row: the shell flips its union capture→edit
      // KEEPING the same session, so this component is NOT remounted — the
      // grow animation and Lexical state survive — and `existing` arrives so
      // the document starts following the live row. The incoming row equals
      // what we just posted, so the first arrival is a no-op rebase.
      onCommitted(task.id);
    } catch (err) {
      // The POST never landed (offline, a rejected create): undo the
      // optimistic transition and drop back to capture so the user can retry.
      // Stash the text as a recovery draft in case they dismiss instead.
      console.error("Failed to create task on ⌘⏎", err);
      transformingRef.current = false;
      setStage("capture");
      saveCaptureDraft(projectId, body);
    }
  }, [beginGrow, client, onCommitted, projectId, queryClient]);

  // ─── Dismiss policy (esc, outside press, ✕) ────────────────────────────────
  // Both stages close INSTANTLY. Saved: flush the dirty fields in the
  // background (save-on-close; a failed flush logs — last-write-wins, single
  // user). Capture: stash the typed body as the recovery draft (cleared when
  // empty) — nothing was ever created, so nothing to delete.
  const dismiss = useCallback(
    (_reason: string) => {
      if (stageRef.current === "saved") {
        onClose();
        void docRef.current
          .flush()
          .catch((err) => console.error("Failed to save task after closing", err));
        return;
      }
      saveCaptureDraft(projectId, docRef.current.body);
      onClose();
    },
    [onClose, projectId],
  );

  useEffect(() => {
    registerDismiss(dismiss);
  }, [dismiss, registerDismiss]);

  // Focus the body editor when the dialog opens (a capture needs no click; an
  // edit opens ready to type at the end of the body).
  useEffect(() => {
    const id = requestAnimationFrame(() => editorRef.current?.focusEnd());
    return () => cancelAnimationFrame(id);
  }, []);

  // ⌘⏎ in the capture stage — a window capture-phase listener so it fires even
  // if the Lexical editor swallows the key. Gated to the capture stage and off
  // during the transform window.
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

  return (
    <div>
      <div
        ref={cardRef}
        className="flex max-h-[76vh] flex-col overflow-hidden rounded-xl border border-[#E4E4E4] bg-white shadow-[0_12px_32px_rgba(0,0,0,0.16)] transition-[height] duration-[250ms] ease-out dark:border-border dark:bg-card"
      >
        {/* Header row — saved stage only (capture is chrome-free). The title
            is metadata presented as window chrome: small, muted, single-line,
            inline with the ✕ — the BODY stays the card's largest, darkest
            element. V2 drops the auto-title spinner (seed-only) and the ⋯
            menu (its actions are PR 4 list mutations). */}
        {stage === "saved" && (
          <div className="flex items-center gap-2 pt-2.5 pr-2.5 pl-5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <input
                aria-label="Task title"
                value={doc.title}
                onChange={(e) => doc.setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    editorRef.current?.focusStart();
                  }
                }}
                placeholder="Untitled"
                spellCheck={false}
                size={1}
                className="hitch-autosize min-w-0 max-w-full truncate border-0 bg-transparent p-0 text-[13px] font-medium leading-4 text-muted-foreground outline-none transition-colors hover:text-foreground focus:text-foreground placeholder:text-muted-foreground/40"
              />
            </div>
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

        {/* PR 5 seam: the tag lane (DialogTagLane's V2 sibling) slots here,
            between the header row and the editor — same spot as V1. */}

        {/* The document area. One MarkdownEditor instance serves both stages —
            it must never remount on the stage flip (focus, caret, and undo
            history ride through the transform). PR 6 seam: attachments arrive
            as the editor's imageUploadHandler/imagePreviewHandler props. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col px-5">
            <div
              className={
                stage === "capture"
                  ? "hitch-capture-compact pt-5 pb-3"
                  : "pt-3 pb-4"
              }
            >
              <MarkdownEditor
                ref={editorRef}
                value={doc.body}
                onChange={doc.setBody}
                placeholder={
                  stage === "capture"
                    ? "What needs doing?"
                    : "Describe what you're working on"
                }
              />
            </div>
          </div>
        </div>

        {/* Footer — the capture coaching strip (V1's, imported: pure
            presentation). The saved stage has no footer band yet: delegation
            is M4; the compose/linked/requested machinery lands there. */}
        {stage === "capture" && <CaptureFooter />}
      </div>
    </div>
  );
}
