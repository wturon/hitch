import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { TagComboboxOption } from "@/components/tags/TagCombobox";
import { nextRotationColor, toTagColor, type TagColorName } from "@/lib/tagColors";
import type { HitchClient } from "@/lib/server/client";
import {
  buildTagOptions,
  tagNamesFor,
  withTaskTagLinked,
  withTaskTagUnlinked,
  type TagRow,
} from "./tagAssignment";

// The V2 tag data layer (M2 PR 5): the ["tags"] query plus every tag write the
// UI makes — create (with a rotation color, V1's Notion behavior), and
// link/unlink on task_tags — owned by ONE hook instance in the shell (AppV2)
// so the row submenu and the dialog's tag lane route through the same
// handlers and the same optimistic cache (V1's "one code path" rule, same as
// useTaskMutations).
//
// Identity: the UI speaks tag NAMES (see tagFilter.ts — that's what lets the
// V1 tag components be imported unchanged); this hook is where names resolve
// to the server's uuids. Link/unlink are optimistic on the tasks cache's
// embedded tagIds (TkDodo onMutate pattern: cancel in-flight ["tasks"]
// queries, snapshot, patch the one row, rollback on error, invalidate on
// settle) — the pill reflects instantly, server truth reconciles behind it.

// What the tag writes need from a cached task row.
export interface TaggableTask {
  id: string;
  tagIds: string[];
}

export interface TagActions {
  /** Combobox options (assign + filter): every server tag, name-as-id. */
  options: TagComboboxOption[];
  /** Tint for a tag name; a name with no loaded row renders gray. */
  colorOf: (name: string) => TagColorName;
  /** A task's tagIds resolved to display names (unknown ids dropped). */
  namesOf: (task: { tagIds: string[] }) => string[];
  /** Assign if absent, unassign if present (the combobox toggle). */
  toggleTag(task: TaggableTask, name: string): void;
  /**
   * Create `name` (rotation color) and assign it to the task — the combobox's
   * `+ Create` row. `name` arrives normalized (TagCombobox kebab-cases it).
   */
  createTag(task: TaggableTask, name: string): void;
}

export async function fetchTags(client: HitchClient): Promise<TagRow[]> {
  const response = await client.tags.$get();
  if (!response.ok) throw new Error(`Failed to list tags (${response.status})`);
  return await response.json();
}

export function useTagMutations(
  client: HitchClient,
  projectId: string | null,
): TagActions {
  const queryClient = useQueryClient();
  // The SAME keys the views query under, so optimistic patches land in the
  // shared cache entries (and the coarse WS invalidation hits them).
  const listKey = ["tasks", { projectId: projectId ?? undefined }] as const;
  const tagsKey = ["tags"] as const;

  const tags = useQuery({ queryKey: tagsKey, queryFn: () => fetchTags(client) });
  const tagRows = useMemo(() => tags.data ?? [], [tags.data]);
  const tagsById = useMemo(
    () => new Map(tagRows.map((tag) => [tag.id, tag])),
    [tagRows],
  );
  const tagsByName = useMemo(
    () => new Map(tagRows.map((tag) => [tag.name, tag])),
    [tagRows],
  );

  const options = useMemo(() => buildTagOptions(tagRows), [tagRows]);
  const colorOf = useCallback(
    (name: string): TagColorName => toTagColor(tagsByName.get(name)?.color),
    [tagsByName],
  );
  const namesOf = useCallback(
    (task: { tagIds: string[] }) => tagNamesFor(task.tagIds, tagsById),
    [tagsById],
  );

  // Link/unlink share one mutation: the endpoint pair is symmetric and so is
  // the optimistic patch (add/remove the id in the one row's tagIds).
  const linkTag = useMutation({
    mutationFn: async ({ taskId, tagId, on }: {
      taskId: string;
      tagId: string;
      on: boolean;
    }) => {
      const response = on
        ? await client.tasks[":id"].tags[":tagId"].$post({
            param: { id: taskId, tagId },
          })
        : await client.tasks[":id"].tags[":tagId"].$delete({
            param: { id: taskId, tagId },
          });
      // Unlinking an already-severed link 404s — the outcome we wanted (the
      // link vanished from another client), not an error.
      if (!response.ok && !(on === false && response.status === 404)) {
        throw new Error(`Failed to update task tags (${response.status})`);
      }
    },
    onMutate: async ({ taskId, tagId, on }) => {
      await queryClient.cancelQueries({ queryKey: ["tasks"] });
      const previous = queryClient.getQueryData<TaggableTask[]>(listKey);
      queryClient.setQueryData<TaggableTask[]>(listKey, (old) =>
        old === undefined
          ? old
          : on
            ? withTaskTagLinked(old, taskId, tagId)
            : withTaskTagUnlinked(old, taskId, tagId),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      console.error("Tag assignment failed; rolling back", error);
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // Create-with-rotation-color (V1's Notion behavior: the Nth tag gets the
  // Nth rotation hue — there is no color picker at creation time). A 409
  // means the name exists server-side but our cache hadn't caught up; adopt
  // the existing row instead of failing (that IS the tag the user meant).
  const createTag = useMutation({
    mutationFn: async (name: string): Promise<TagRow> => {
      const response = await client.tags.$post({
        json: { name, color: nextRotationColor(tagRows.length) },
      });
      if (response.status === 409) {
        const existing = (await fetchTags(client)).find((tag) => tag.name === name);
        if (existing) return existing;
      }
      if (!response.ok) throw new Error(`Failed to create tag (${response.status})`);
      return await response.json();
    },
    onSuccess: (tag) => {
      // Into the cache NOW (name-sorted, matching GET /tags), so the new
      // pill/option resolves before the refetch lands.
      queryClient.setQueryData<TagRow[]>(tagsKey, (old) =>
        [...(old ?? []).filter((t) => t.id !== tag.id), tag].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        ),
      );
    },
    onError: (error) => {
      console.error("Tag creation failed", error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: tagsKey });
    },
  });

  return {
    options,
    colorOf,
    namesOf,
    toggleTag: (task, name) => {
      const tag = tagsByName.get(name);
      if (!tag) return; // options only list loaded rows; a race just no-ops
      linkTag.mutate({
        taskId: task.id,
        tagId: tag.id,
        on: !task.tagIds.includes(tag.id),
      });
    },
    createTag: (task, name) => {
      const existing = tagsByName.get(name);
      // The combobox hides Create when the name exists, but guard anyway:
      // creating an existing tag means "assign it".
      if (existing) {
        if (!task.tagIds.includes(existing.id)) {
          linkTag.mutate({ taskId: task.id, tagId: existing.id, on: true });
        }
        return;
      }
      createTag.mutate(name, {
        onSuccess: (tag) => {
          linkTag.mutate({ taskId: task.id, tagId: tag.id, on: true });
        },
      });
    },
  };
}
