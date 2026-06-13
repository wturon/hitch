"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { CheckIcon, CopyIcon, LoaderCircle, XIcon } from "lucide-react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import { parseFrontmatter } from "@/lib/frontmatter";
import {
  clearChatFields,
  parseChatOpenState,
  parseChatRef,
  parseChatStatus,
  type Harness,
} from "@/lib/chat";
import { DelegationBand } from "@/components/DelegationBand";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// What the dialog needs to render and save a task. `content` is the raw file
// text (frontmatter + body); we edit it wholesale and write it back verbatim.
export interface TaskTarget {
  projectId: Id<"projects">;
  path: string; // tasks/<slug>/task.md
  title: string;
  content: string;
}

export function TaskDialog({
  task,
  onOpenChange,
  onManagePrompts,
  onManageHarnesses,
}: {
  task: TaskTarget | null;
  onOpenChange: (open: boolean) => void;
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
        className="flex h-[82vh] max-h-[820px] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        {task && (
          // Key by identity so the editor's draft state resets per task,
          // rather than persisting a stale draft when a different card opens.
          <TaskEditor
            key={task.path}
            task={task}
            onClose={() => onOpenChange(false)}
            registerClose={(fn) => {
              closeWithSaveRef.current = fn;
            }}
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
  onManagePrompts,
  onManageHarnesses,
}: {
  task: TaskTarget;
  onClose: () => void;
  registerClose: (fn: () => void) => void;
  onManagePrompts?: () => void;
  onManageHarnesses?: () => void;
}) {
  const upsertFile = useMutation(api.files.upsertFile);
  const enqueue = useMutation(api.commands.enqueueCommand);
  // Follow the live task file. Hitch is last-write-wins, so if another writer
  // (e.g. the agent linking a session) updates the task while the modal is open,
  // the editor — and the delegation band, which reads the draft — updates too.
  const [draft, setDraft] = useState(() => task.content);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeInFlightRef = useRef(false);
  const dirty = draft !== task.content;

  useEffect(() => {
    setDraft(task.content);
  }, [task.content]);

  // The linked chat rides the file's frontmatter; the band reads it from the
  // (live-following) draft, so it swaps compose↔linked on its own.
  const fm = parseFrontmatter(draft).frontmatter;
  const chat = parseChatRef(fm);
  const chatStatus = parseChatStatus(fm);
  const chatOpenState = parseChatOpenState(fm);

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
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await persist(draft);
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
    const content = draft;
    const shouldPersist = dirty;
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
    if (dirty) await persist(draft);
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
    const cleared = clearChatFields(draft);
    setDraft(cleared);
    await persist(cleared);
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(task.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be unavailable (e.g. no permission); silently ignore.
    }
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          void saveDraft();
        }
      }}
    >
      {/* Path chip, top-left — floats over the scrolling body, so it gets a
          solid white surface + border to stay legible. */}
      <div className="absolute top-3 left-3.5 z-10 flex items-center gap-1 rounded-lg border bg-background py-1 pr-1 pl-2.5">
        <span className="max-w-[22rem] truncate font-mono text-xs text-muted-foreground">
          {task.path}
        </span>
        <button
          type="button"
          aria-label="Copy path"
          onClick={() => void copyPath()}
          className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? (
            <CheckIcon className="size-3" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </button>
      </div>

      {/* X, top-right — same floating treatment. Dismisses immediately and saves
          a dirty draft in the background. */}
      <button
        type="button"
        aria-label="Close"
        disabled={saving}
        onClick={closeWithSave}
        className={cn(
          "absolute top-3 right-3 z-10 flex size-7 items-center justify-center rounded-lg border bg-background text-muted-foreground",
          "hover:bg-muted hover:text-foreground disabled:pointer-events-none",
        )}
      >
        {saving ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <XIcon className="size-4" />
        )}
      </button>

      {/* Body editor — the whole modal. Borderless, full-bleed; raw markdown is
          kept honest (frontmatter + body, edited verbatim). Top padding clears
          the chips; bottom padding lets content scroll behind the floating bar. */}
      <textarea
        aria-label="Task content"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoFocus
        className="h-full w-full resize-none bg-transparent px-6 pt-14 pb-32 font-mono text-xs leading-relaxed outline-none"
      />

      {/* Floating delegate bar, pinned over the bottom of the document. */}
      <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10">
        <div className="pointer-events-auto">
          <DelegationBand
            projectId={task.projectId}
            chat={chat}
            chatStatus={chatStatus}
            chatOpenState={chatOpenState}
            title={task.title}
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
