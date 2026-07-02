"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { sha256 } from "@/lib/hash";
import {
  deriveTitleFromBody,
  taskBodyPath,
  taskSlug,
  uniqueSlug,
} from "@/lib/tasks";
import type { TaskDraft } from "@/hooks/useTaskDraft";

// A task's file either exists on disk (a normal card, or a draft after its first
// save-point) or doesn't yet (a fresh keyboard/`+` draft held only in memory).
// This is the one piece of lifecycle state; everything else is derived from it.
export type TaskFileState =
  | { readonly status: "draft" }
  | { readonly status: "committed"; readonly path: string };

export interface TaskPersistence {
  // The current file state (draft vs. committed) and a ref mirror for async reads.
  state: TaskFileState;
  stateRef: React.RefObject<TaskFileState>;
  // The committed path, or null while still a draft. Convenience over `state`.
  committedPath: string | null;
  // The task folder slug, or null while a draft (attachments stay inert until then).
  slug: string | null;
  // The path the task will live at: the real file once committed, else the slug a
  // draft *would* get from its current title (so the delegate bar can advertise a
  // correct launch/preamble path before the file exists — commitDraft mints the
  // same slug from the same inputs).
  prospectivePath: string;
  // Write `content` to the committed file (defaults to the current committed path,
  // read via ref so it's live inside async handlers). No-op while still a draft —
  // a draft is created through commitDraft, never persist.
  persist: (content: string, path?: string) => Promise<void>;
  // Materialize a draft into a real file, or return the existing path if already
  // committed. Resolves a title (typed, else derived from the body), mints a
  // non-colliding slug, folds the title into the frontmatter, and writes the file
  // through the app's optimistic upsert (so the card appears instantly). Returns
  // null — writing nothing — when there's no title and `allowEmpty` is false, so
  // an empty draft discards on close instead of littering the board. `allowEmpty`
  // forces creation (a pasted attachment needs a slug now; it falls back to "task").
  commitDraft: (opts?: { allowEmpty?: boolean }) => Promise<string | null>;
}

// Owns a task dialog's create/persist policy so the dialog UI doesn't carry the
// lazy-create workflow inline. `onMaterialize` writes a freshly-created draft
// through the app's optimistic upsert; ordinary saves use this hook's own
// mutation. `draft` is the live document model the dialog edits.
export function useTaskPersistence({
  projectId,
  initialPath,
  isDraft,
  draft,
  takenSlugs,
  onMaterialize,
}: {
  projectId: Id<"projects">;
  initialPath: string; // tasks/<slug>/task.md, or "" for a fresh draft
  isDraft: boolean;
  draft: TaskDraft;
  takenSlugs: string[];
  onMaterialize: (path: string, content: string) => Promise<void>;
}): TaskPersistence {
  const upsertFile = useMutation(api.files.upsertFile);
  const [state, setState] = useState<TaskFileState>(() =>
    isDraft ? { status: "draft" } : { status: "committed", path: initialPath },
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const committedPath =
    state.status === "committed" ? state.path : null;
  const slug = committedPath ? taskSlug(committedPath) : null;

  // Resolve the title a save/derive would use right now (typed title wins, else
  // the body's first line). Shared by prospectivePath and commitDraft so the slug
  // they compute always agrees.
  const resolveTitle = () => draft.title.trim() || deriveTitleFromBody(draft.body);

  const prospectivePath =
    committedPath ??
    taskBodyPath(uniqueSlug(resolveTitle(), new Set(takenSlugs), "task"));

  async function persist(
    content: string,
    path = stateRef.current.status === "committed"
      ? stateRef.current.path
      : null,
  ) {
    if (!path) return;
    await upsertFile({
      projectId,
      path,
      content,
      hash: await sha256(content),
      deleted: false,
    });
  }

  async function commitDraft(opts?: {
    allowEmpty?: boolean;
  }): Promise<string | null> {
    if (stateRef.current.status === "committed") return stateRef.current.path;
    const title = resolveTitle();
    if (!title && !opts?.allowEmpty) return null;
    const path = taskBodyPath(uniqueSlug(title, new Set(takenSlugs), "task"));
    const content = draft.setFrontmatter({ title });
    const next: TaskFileState = { status: "committed", path };
    setState(next);
    stateRef.current = next;
    await onMaterialize(path, content);
    return path;
  }

  return {
    state,
    stateRef,
    committedPath,
    slug,
    prospectivePath,
    persist,
    commitDraft,
  };
}
