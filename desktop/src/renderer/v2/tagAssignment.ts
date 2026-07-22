// V2 tag assignment math (M2 PR 5). The pure half of useTagMutations — no
// React, no HTTP — siblinging lib/tagAssignment, which is welded to the V1
// registry model (config.json + names-as-ids frontmatter). In V2 the server's
// `tags` table IS the registry: rows carry a uuid, a unique-per-user name and
// a named tint color, and a task's membership lives in `task_tags` (surfaced
// as `tagIds` on every task response). Names stay the UI-level identity (see
// tagFilter.ts); uuids appear here because these helpers patch the tasks
// cache, which stores tagIds.

import type { TagComboboxOption } from "@/components/tags/TagCombobox";
import { toTagColor } from "@/lib/tagColors";

// The minimal tag-row shape the helpers need from GET /tags.
export interface TagRow {
  id: string;
  name: string;
  color: string;
}

// The assign/filter combobox options: every server tag, name-as-id, in the
// server's name order. Unknown color strings clamp to gray (the server stores
// free-form text; only palette names render a tint). Unlike V1 there is no
// "present on the task but unregistered" union — a task_tags link can only
// point at an existing tags row.
export function buildTagOptions(tags: TagRow[]): TagComboboxOption[] {
  return tags.map((tag) => ({ id: tag.name, color: toTagColor(tag.color) }));
}

// tagIds → display names via the live tag rows. A link whose tag row isn't
// loaded (or was deleted mid-flight) resolves to nothing — never a raw uuid.
export function tagNamesFor(
  tagIds: string[],
  tagsById: Map<string, TagRow>,
): string[] {
  return tagIds.flatMap((id) => {
    const tag = tagsById.get(id);
    return tag ? [tag.name] : [];
  });
}

// --- Optimistic tasks-cache patches ------------------------------------------
// The one task's tagIds with `tagId` linked/unlinked — the cache projection of
// POST/DELETE /tasks/:id/tags/:tagId. Pure and idempotent (re-linking an
// existing id is a no-op, matching the server's onConflictDoNothing); every
// other row is returned untouched.

interface TaggedTask {
  id: string;
  tagIds: string[];
}

export function withTaskTagLinked<T extends TaggedTask>(
  tasks: T[],
  taskId: string,
  tagId: string,
): T[] {
  return tasks.map((task) =>
    task.id === taskId && !task.tagIds.includes(tagId)
      ? { ...task, tagIds: [...task.tagIds, tagId] }
      : task,
  );
}

export function withTaskTagUnlinked<T extends TaggedTask>(
  tasks: T[],
  taskId: string,
  tagId: string,
): T[] {
  return tasks.map((task) =>
    task.id === taskId && task.tagIds.includes(tagId)
      ? { ...task, tagIds: task.tagIds.filter((id) => id !== tagId) }
      : task,
  );
}
