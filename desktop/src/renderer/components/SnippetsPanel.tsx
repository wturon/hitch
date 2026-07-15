"use client";

import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Snippet {
  _id: Id<"snippets">;
  name: string;
  body: string;
  updatedAt: number;
}

interface EditorDraft {
  id: Id<"snippets"> | null;
  name: string;
  body: string;
}

// Convex mutation errors arrive wrapped in transport noise
// ("[CONVEX M(snippets:create)] [Request ID: …] Server Error\nUncaught Error:
// <message>\n  at …"). Pull out the user-facing message the mutation threw.
function mutationErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const marker = "Uncaught Error: ";
  const start = raw.indexOf(marker);
  if (start === -1) return raw;
  const rest = raw.slice(start + marker.length);
  const end = rest.indexOf("\n");
  return (end === -1 ? rest : rest.slice(0, end)).trim() || raw;
}

// Manage the user's snippet library. Snippets live in Convex (synced across
// devices), so unlike the starting-prompts panel next door this reads through a
// live query and writes through mutations — the list is never edited locally.
export function SnippetsPanel() {
  const snippets = useQuery(api.snippets.list, {});
  const createSnippet = useMutation(api.snippets.create);
  const updateSnippet = useMutation(api.snippets.update);
  const removeSnippet = useMutation(api.snippets.remove);

  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<Id<"snippets"> | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const sorted = snippets
    ? [...snippets].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      )
    : null;

  function openEditor(draft: EditorDraft) {
    setEditor(draft);
    setEditorError(null);
  }

  async function saveDraft(draft: EditorDraft) {
    setSaving(true);
    setEditorError(null);
    try {
      if (draft.id === null) {
        await createSnippet({ name: draft.name.trim(), body: draft.body });
      } else {
        await updateSnippet({
          id: draft.id,
          name: draft.name.trim(),
          body: draft.body,
        });
      }
      setEditor(null);
    } catch (err) {
      setEditorError(mutationErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteSnippet(id: Id<"snippets">) {
    setDeletingId(id);
    setListError(null);
    try {
      await removeSnippet({ id });
      if (editor?.id === id) setEditor(null);
    } catch (err) {
      setListError(mutationErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Snippets</h3>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            Reusable text you can insert anywhere with /
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={editor?.id === null}
          onClick={() => openEditor({ id: null, name: "", body: "" })}
        >
          <PlusIcon />
          New snippet
        </Button>
      </div>

      {listError && <p className="text-sm text-destructive">{listError}</p>}

      {sorted && sorted.length === 0 && !editor && (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          No snippets yet.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {sorted?.map((snippet) =>
          editor && editor.id === snippet._id ? (
            <SnippetEditor
              key={snippet._id}
              draft={editor}
              saving={saving}
              error={editorError}
              onChange={setEditor}
              onSave={(draft) => void saveDraft(draft)}
              onCancel={() => setEditor(null)}
              onDelete={() => void deleteSnippet(snippet._id)}
            />
          ) : (
            <SnippetRow
              key={snippet._id}
              snippet={snippet}
              deleting={deletingId === snippet._id}
              onEdit={() =>
                openEditor({
                  id: snippet._id,
                  name: snippet.name,
                  body: snippet.body,
                })
              }
              onDelete={() => void deleteSnippet(snippet._id)}
            />
          ),
        )}

        {editor?.id === null && (
          <SnippetEditor
            draft={editor}
            saving={saving}
            error={editorError}
            onChange={setEditor}
            onSave={(draft) => void saveDraft(draft)}
            onCancel={() => setEditor(null)}
          />
        )}
      </div>
    </div>
  );
}

function SnippetRow({
  snippet,
  deleting,
  onEdit,
  onDelete,
}: {
  snippet: Snippet;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const preview = snippet.body.trim().split("\n")[0] ?? "";
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{snippet.name}</p>
        <p className="truncate text-xs text-muted-foreground">{preview}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Edit ${snippet.name}`}
          disabled={deleting}
          onClick={onEdit}
        >
          <PencilIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${snippet.name}`}
          disabled={deleting}
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </div>
    </div>
  );
}

function SnippetEditor({
  draft,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  draft: EditorDraft;
  saving: boolean;
  error: string | null;
  onChange: (draft: EditorDraft) => void;
  onSave: (draft: EditorDraft) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const nameId = useId();
  const bodyId = useId();
  const canSave = draft.name.trim().length > 0 && !saving;

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
          placeholder="e.g. Bug report template"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
          className="h-9 rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={bodyId}
          className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Body
        </label>
        <textarea
          id={bodyId}
          value={draft.body}
          rows={4}
          spellCheck={false}
          placeholder="The text to insert"
          onChange={(e) => onChange({ ...draft, body: e.target.value })}
          className="resize-none rounded-md border bg-background p-2.5 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center justify-between gap-2">
        {onDelete ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={saving}
            onClick={onDelete}
          >
            <Trash2Icon />
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSave}
            onClick={() => onSave(draft)}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
