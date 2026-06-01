"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { sha256 } from "@/lib/hash";
import { parseFrontmatter } from "@/lib/frontmatter";
import {
  HARNESSES,
  clearChatFields,
  harnessLabel,
  parseChatRef,
  parseChatStatus,
  readChatFields,
  writeChatFields,
  type ChatFields,
} from "@/lib/chat";
import { ChatLaunch } from "@/components/ChatLaunch";
import { ChatStart } from "@/components/ChatStart";
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
  project: string;
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
            key={task.path}
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
  const [draft, setDraft] = useState(() => task.content);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== task.content;

  // The linked chat is stored in the draft's frontmatter, so editing it here
  // and hitting Save flows through the same path as any other edit. Read the
  // (possibly half-filled) fields for the form, and a validated ref for launch.
  const fm = parseFrontmatter(draft).frontmatter;
  const fields = readChatFields(fm);
  const chat = parseChatRef(fm);
  const chatStatus = parseChatStatus(fm);

  function updateChat(patch: Partial<ChatFields>) {
    setDraft((d) =>
      writeChatFields(d, {
        ...readChatFields(parseFrontmatter(d).frontmatter),
        ...patch,
      }),
    );
  }

  async function save() {
    setSaving(true);
    try {
      await upsertFile({
        project: task.project,
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
        <DialogDescription>{task.path}</DialogDescription>
      </DialogHeader>

      <section className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Linked chat
          </span>
          {chat ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setDraft(clearChatFields)}
              >
                Clear
              </Button>
              <ChatLaunch
                chat={chat}
                status={chatStatus}
                project={task.project}
                size="xs"
              />
            </div>
          ) : (
            fields.harness && (
              <span className="text-xs text-muted-foreground/70">
                add a session id to enable
              </span>
            )
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <select
            aria-label="Chat harness"
            value={fields.harness}
            onChange={(e) => updateChat({ harness: e.target.value })}
            className="h-8 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">No chat</option>
            {HARNESSES.map((h) => (
              <option key={h} value={h}>
                {harnessLabel(h)}
              </option>
            ))}
          </select>

          {fields.harness && (
            <input
              aria-label="Chat session id"
              value={fields.id}
              onChange={(e) => updateChat({ id: e.target.value })}
              placeholder="session / thread id"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
        </div>

        {fields.harness === "claude-code" && (
          <input
            aria-label="Working directory"
            value={fields.cwd}
            onChange={(e) => updateChat({ cwd: e.target.value })}
            placeholder="working directory (optional, for resume)"
            spellCheck={false}
            className="h-8 w-full rounded-md border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        )}
      </section>

      {/* No chat yet → offer to spawn a fresh coding-agent session for this
          task. Once the daemon/agent links it, `chat` becomes non-null and the
          resume button above replaces this. */}
      {!chat && (
        <ChatStart
          project={task.project}
          path={task.path}
          title={task.title}
        />
      )}

      <textarea
        aria-label="Task content"
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
