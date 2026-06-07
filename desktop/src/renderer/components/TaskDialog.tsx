"use client";

import { useEffect, useState } from "react";
import { useMutation } from "convex/react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
}: {
  task: TaskTarget | null;
  onOpenChange: (open: boolean) => void;
  onManagePrompts?: () => void;
}) {
  return (
    <Dialog open={task !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        {task && (
          // Key by identity so the editor's draft state resets per task,
          // rather than persisting a stale draft when a different card opens.
          <TaskEditor
            key={task.path}
            task={task}
            onClose={() => onOpenChange(false)}
            onManagePrompts={onManagePrompts}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskEditor({
  task,
  onClose,
  onManagePrompts,
}: {
  task: TaskTarget;
  onClose: () => void;
  onManagePrompts?: () => void;
}) {
  const upsertFile = useMutation(api.files.upsertFile);
  const enqueue = useMutation(api.commands.enqueueCommand);
  // Follow the live task file. Hitch is last-write-wins, so if another writer
  // (e.g. the agent linking a session) updates the task while the modal is open,
  // the editor — and the delegation band, which reads the draft — updates too.
  const [draft, setDraft] = useState(() => task.content);
  const [saving, setSaving] = useState(false);
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

  async function save({ close }: { close: boolean }) {
    setSaving(true);
    try {
      await persist(draft);
      if (close) onClose();
    } finally {
      setSaving(false);
    }
  }

  // Save the current edits, then ask the daemon to spawn the session. We keep
  // the modal open: the daemon links the session into the file, the live task
  // flows back, and the band swaps to its linked state on its own. model/effort
  // ride the command for the kickoff only — they're never written to the task.
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
    await persist(draft);
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

  return (
    <>
      <DialogHeader>
        <DialogTitle>{task.title}</DialogTitle>
        <DialogDescription>{task.path}</DialogDescription>
      </DialogHeader>

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
      />

      <textarea
        aria-label="Task content"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoFocus
        className="h-80 w-full resize-none rounded-md border bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={saving} />}>
          Cancel
        </DialogClose>
        <Button
          variant="outline"
          onClick={() => void save({ close: false })}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button onClick={() => void save({ close: true })} disabled={saving}>
          Save &amp; close
        </Button>
      </DialogFooter>
    </>
  );
}
