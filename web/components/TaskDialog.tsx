"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { sha256 } from "@/lib/hash";
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
  workspace: string;
  source: string;
  path: string; // tasks/<slug>/task.md
  title: string;
  content: string;
}

export function TaskDialog({
  task,
  onOpenChange,
}: {
  task: TaskTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={task !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        {task && (
          // Key by identity so the editor's draft state resets per task,
          // rather than persisting a stale draft when a different card opens.
          <TaskEditor
            key={`${task.source}/${task.path}`}
            task={task}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TaskEditor({
  task,
  onClose,
}: {
  task: TaskTarget;
  onClose: () => void;
}) {
  const upsertFile = useMutation(api.files.upsertFile);
  // Snapshot on open: we don't live-patch the textarea from remote changes
  // while editing. Save is last-write-wins, which is fine for a single user.
  const [draft, setDraft] = useState(task.content);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== task.content;

  async function save() {
    setSaving(true);
    try {
      await upsertFile({
        workspace: task.workspace,
        source: task.source,
        path: task.path,
        content: draft,
        hash: await sha256(draft),
        deleted: false,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{task.title}</DialogTitle>
        <DialogDescription>
          {task.source}/{task.path}
        </DialogDescription>
      </DialogHeader>

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoFocus
        className="h-80 w-full resize-none rounded-md border bg-transparent p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <DialogFooter>
        <DialogClose
          render={<Button variant="outline" disabled={saving} />}
        >
          Cancel
        </DialogClose>
        <Button onClick={save} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
