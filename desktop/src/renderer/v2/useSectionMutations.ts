import { useMutation, useQueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";

import { sortOrderAtIndex } from "./listMutations";

import type { HitchClient } from "@/lib/server/client";
import type { SectionItem } from "./useSections";

// Every write the list makes to a project's SECTIONS. Same shape and the same
// TkDodo optimistic pattern as useTaskMutations: cancel in-flight queries so a
// racing refetch can't clobber the optimistic rows, snapshot, patch, roll back
// on error, invalidate on settle.
//
// Sections are inert structure — no status, no derivation, nothing the daemon
// reads. That's what keeps this small: a create, a rename, a reorder and a
// delete, all single-row.

export interface SectionMutations {
  /** Append a section at the end of the project's list. */
  createSection(name: string): void;
  renameSection(sectionId: string, name: string): void;
  /** Move one section between its new neighbours (precomputed sortOrder). */
  reorderSection(sectionId: string, sortOrder: string): void;
  /**
   * Delete a section. Its TASKS SURVIVE: the FK is `on delete set null`, so
   * they fall back to loose. The tasks query is invalidated alongside the
   * sections one because the server has silently rewritten rows in it.
   */
  deleteSection(sectionId: string): void;
}

/**
 * The sortOrder for a section appended after `sections` (which must be in list
 * order). Sections are created at the END — a new section is a place you are
 * about to fill, not a claim on the top of the project.
 */
export function appendSectionSortOrder(
  sections: ReadonlyArray<{ sortOrder: string }>,
): string {
  // The MAX key, not the last element's. The array this is handed is the raw
  // cache, and an optimistic reorder rewrites a row's sortOrder in place
  // without moving it — so `at(-1)` is not reliably the largest, and appending
  // after it mints a key that collides with a section further down.
  let max: string | null = null;
  for (const section of sections) {
    if (max === null || section.sortOrder > max) max = section.sortOrder;
  }
  return generateKeyBetween(max, null);
}

/**
 * The sortOrder for the section at `index` moving one step in `direction`.
 * Returns null at the ends (nothing to swap with), so the caller skips the
 * PATCH. Computed between the destination's neighbours in the CURRENT list,
 * exactly like a task drag — one row's key changes, never the whole list.
 */
export function stepSectionSortOrder(
  sections: ReadonlyArray<{ sortOrder: string }>,
  index: number,
  direction: "up" | "down",
): string | null {
  if (index < 0 || index >= sections.length) return null;
  if (direction === "up" ? index === 0 : index === sections.length - 1) return null;
  // Same shape as a task drag: take the section out, then insert it one place
  // further along. Routing through sortOrderAtIndex means a duplicate key among
  // the sections widens rather than throwing or colliding.
  const rest = sections.filter((_, i) => i !== index);
  return sortOrderAtIndex(rest, direction === "up" ? index - 1 : index + 1);
}

export function useSectionMutations(
  client: HitchClient,
  projectId: string,
): SectionMutations {
  const queryClient = useQueryClient();
  // The SAME key useSections queries under, so optimistic patches land in the
  // one shared cache entry.
  const listKey = ["sections", { projectId }] as const;

  const invalidateSections = () => {
    void queryClient.invalidateQueries({ queryKey: ["sections"] });
  };

  const createSection = useMutation({
    mutationFn: async (name: string) => {
      const current = queryClient.getQueryData<SectionItem[]>(listKey) ?? [];
      const response = await client.sections.$post({
        json: { projectId, name, sortOrder: appendSectionSortOrder(current) },
      });
      if (!response.ok) throw new Error(`Failed to create section (${response.status})`);
      return await response.json();
    },
    // Deliberately NOT optimistic: a section's id is the server's to mint, and
    // a placeholder id would have to be reconciled everywhere a task's
    // sectionId points. Creating is a rare, deliberate act — a refetch is fast
    // enough, and correctness here is worth more than the frame.
    onError: (error) => {
      console.error("Failed to create section", error);
    },
    onSettled: invalidateSections,
  });

  const patchSection = useMutation({
    mutationFn: async ({
      sectionId,
      patch,
    }: {
      sectionId: string;
      patch: { name?: string; sortOrder?: string };
    }) => {
      const response = await client.sections[":id"].$patch({
        param: { id: sectionId },
        json: patch,
      });
      if (!response.ok) throw new Error(`Failed to update section (${response.status})`);
      return await response.json();
    },
    onMutate: async ({ sectionId, patch }) => {
      await queryClient.cancelQueries({ queryKey: ["sections"] });
      const previous = queryClient.getQueryData<SectionItem[]>(listKey);
      queryClient.setQueryData<SectionItem[]>(listKey, (old) =>
        old?.map((section) =>
          section.id === sectionId ? { ...section, ...patch } : section,
        ),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      console.error("Section update failed; rolling back", error);
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: invalidateSections,
  });

  const deleteSection = useMutation({
    mutationFn: async (sectionId: string) => {
      const response = await client.sections[":id"].$delete({
        param: { id: sectionId },
      });
      // 404 = already gone; the goal state holds either way.
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete section (${response.status})`);
      }
    },
    onMutate: async (sectionId) => {
      await queryClient.cancelQueries({ queryKey: ["sections"] });
      const previous = queryClient.getQueryData<SectionItem[]>(listKey);
      queryClient.setQueryData<SectionItem[]>(listKey, (old) =>
        old?.filter((section) => section.id !== sectionId),
      );
      // The tasks aren't touched here on purpose. deriveSectionedTasks renders
      // a task whose section has vanished as LOOSE, which is exactly where the
      // server is about to put it — so the optimistic frame already matches the
      // outcome, and no task row has to be guessed at.
      return { previous };
    },
    onError: (error, _sectionId, context) => {
      console.error("Section delete failed; rolling back", error);
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => {
      invalidateSections();
      // The server nulled section_id on every task that was filed here.
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  return {
    createSection: (name) => createSection.mutate(name),
    renameSection: (sectionId, name) =>
      patchSection.mutate({ sectionId, patch: { name } }),
    reorderSection: (sectionId, sortOrder) =>
      patchSection.mutate({ sectionId, patch: { sortOrder } }),
    deleteSection: (sectionId) => deleteSection.mutate(sectionId),
  };
}
