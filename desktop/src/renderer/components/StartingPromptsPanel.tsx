"use client";

import { useEffect, useId, useState } from "react";
import { LockIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { PROMPT_TEMPLATE_FRAMING } from "@hitch/shared";

import { Button } from "@/components/ui/button";
import {
  BUILTIN_STARTING_PROMPTS,
  loadCustomPrompts,
  saveCustomPrompts,
  type StartingPrompt,
} from "@/lib/chat";

interface EditorDraft {
  id: string;
  name: string;
  body: string;
  isNew: boolean;
}

// Seeded with the shared framing rather than blank: a prompt is the WHOLE text
// the agent gets now, so an empty box would quietly produce a prompt with no
// task in it. Starting from the framing makes the variables discoverable by
// example and leaves only the instruction to write.
function newDraft(): EditorDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    body: `${PROMPT_TEMPLATE_FRAMING}\n\n`,
    isNew: true,
  };
}

// Manage the kickoff prompts shown in the task delegation dropdown. Two groups:
// the curated built-ins (shipped with the app, locked, shown read-only) and the
// user's own prompts (the editable list persisted here). In the dropdown the
// built-ins come first and "Ship it" is the default selection. Edits here are the
// only ones that persist — tweaks made in the delegation dialog are one-off and
// never write back.
export function StartingPromptsPanel() {
  const [prompts, setPrompts] = useState<StartingPrompt[]>([]);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    void loadCustomPrompts().then((list) => {
      if (active) {
        setPrompts(list);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function persist(next: StartingPrompt[]) {
    setPrompts(next);
    const saved = await saveCustomPrompts(next);
    setPrompts(saved);
  }

  function startEdit(prompt: StartingPrompt) {
    setEditor({ ...prompt, isNew: false });
  }

  function saveDraft(draft: EditorDraft) {
    const prompt: StartingPrompt = {
      id: draft.id,
      name: draft.name.trim(),
      body: draft.body,
    };
    const next = draft.isNew
      ? [...prompts, prompt]
      : prompts.map((p) => (p.id === prompt.id ? prompt : p));
    setEditor(null);
    void persist(next);
  }

  function deletePrompt(id: string) {
    if (editor?.id === id) setEditor(null);
    void persist(prompts.filter((p) => p.id !== id));
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Built-in prompts — curated, shipped with the app, not editable. */}
      <div className="flex flex-col gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Built-in prompts</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Curated kickoff prompts that ship with Hitch and improve with each
            update. They can't be edited or removed.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          {BUILTIN_STARTING_PROMPTS.map((prompt) => (
            <PromptRow key={prompt.id} prompt={prompt} locked />
          ))}
        </div>
      </div>

      {/* The user's own prompts — the editable, persisted library. */}
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-medium">Your prompts</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Reusable kickoff instructions you write. They appear in the
              dropdown after the built-ins.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={editor?.isNew}
            onClick={() => setEditor(newDraft())}
          >
            <PlusIcon />
            New prompt
          </Button>
        </div>

        {loaded && prompts.length === 0 && !editor && (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            No prompts yet. Create one to pick it when delegating a task.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {prompts.map((prompt) =>
            editor && !editor.isNew && editor.id === prompt.id ? (
              <PromptEditor
                key={prompt.id}
                draft={editor}
                onChange={setEditor}
                onSave={saveDraft}
                onCancel={() => setEditor(null)}
                onDelete={() => deletePrompt(prompt.id)}
              />
            ) : (
              <PromptRow
                key={prompt.id}
                prompt={prompt}
                onEdit={() => startEdit(prompt)}
                onDelete={() => deletePrompt(prompt.id)}
              />
            ),
          )}

          {editor?.isNew && (
            <PromptEditor
              draft={editor}
              onChange={setEditor}
              onSave={saveDraft}
              onCancel={() => setEditor(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// One row in either list. Built-in rows pass `locked`, which swaps the edit/
// delete actions for a static badge.
function PromptRow({
  prompt,
  onEdit,
  onDelete,
  locked = false,
}: {
  prompt: StartingPrompt;
  onEdit?: () => void;
  onDelete?: () => void;
  locked?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{prompt.name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {prompt.body || "No instructions"}
        </p>
      </div>
      {locked ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <LockIcon className="size-3" />
          Built-in
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${prompt.name}`}
            onClick={onEdit}
          >
            <PencilIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${prompt.name}`}
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        </div>
      )}
    </div>
  );
}

function PromptEditor({
  draft,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: EditorDraft;
  onChange: (draft: EditorDraft) => void;
  onSave: (draft: EditorDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const nameId = useId();
  const bodyId = useId();
  const canSave = draft.name.trim().length > 0;

  return (
    <div className="flex flex-col gap-3.5 rounded-lg border border-foreground/30 bg-muted/20 p-3.5 shadow-sm">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={nameId}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Name
        </label>
        <input
          id={nameId}
          value={draft.name}
          autoFocus
          placeholder="e.g. Write tests"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          className="h-9 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={bodyId}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Prompt
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          This is the whole prompt — nothing else is added. Use{" "}
          <code>$TASK_TITLE</code>, <code>$TASK_BODY</code> and{" "}
          <code>$TASK_ID</code> to pull in the task.
        </p>
        <textarea
          id={bodyId}
          value={draft.body}
          rows={10}
          spellCheck={false}
          placeholder="What should the agent do?"
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
          className="resize-none rounded-md border bg-background p-2.5 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2Icon />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

