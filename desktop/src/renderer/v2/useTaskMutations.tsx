import { useMemo, useRef, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { HitchClient } from "@/lib/server/client";
import { showUndoableToast } from "@/lib/undoToast";
import { assignmentsToStopOnDone, type StoppableAssignment } from "./delegation";
import { uncheckSortOrder } from "./listMutations";
import { tasksInContainer, type PlacedTask, type SectionRow } from "./sectionGroups";
import {
  createPendingDeleteStore,
  PENDING_DELETE_TOAST_MS,
} from "./pendingDelete";
import type { TaskRow } from "./todoGroups";

// The V2 list mutations (M2 PR 4): check/uncheck, drag reorder, delete with
// undo — every server write the list makes, owned by ONE hook instance in the
// shell (App) so the list, the dialog ⋯ menu and the keyboard shortcuts all
// route through the same handlers, the same optimistic cache and the same
// pending-delete set (V1's "row and dialog share one code path" rule).
//
// Optimistic updates follow the TkDodo onMutate pattern: cancel in-flight
// ["tasks"] queries (so a refetch that raced the click can't clobber the
// optimistic rows when it lands), snapshot the lists, patch the one row,
// rollback on error, invalidate on settle. The WS invalidation arriving after
// settle just refetches server truth — by then identical to the cache.
//
// The patch goes into EVERY cached ["tasks", …] entry, not just this hook's
// project. More than one task list can be cached at a time (a project's list
// and the cross-project "all tasks" list, whose key is ["tasks", {}]), and the
// same task can appear in both: patching one entry leaves the other showing
// stale truth until a refetch lands, which reads as "the click did nothing".
// setQueriesData/getQueriesData are the prefix-matching forms of
// setQueryData/getQueryData, and every ["tasks", …] entry in this app holds a
// task array (see lib/server/queryKeys.ts), so the shape is uniform.

// What the mutations need from a cached task row — a structural subset of the
// GET /tasks response (spreads keep the fields we don't model, e.g. tagIds).
export interface MutableTask extends TaskRow, PlacedTask {
  title: string;
}

interface TaskPatch {
  status?: "open" | "done";
  sortOrder?: string;
  sectionId?: string | null;
}

export interface TaskMutations {
  /** Tasks hidden from the list while their delete window runs. */
  pendingDeleteIds: ReadonlySet<string>;
  /**
   * Check/uncheck. Checking PATCHes status:"done" (the server stamps
   * completed_at) and offers an undo toast; unchecking returns the task to
   * the TOP of the backlog (fractional-index prepend, client-computed) —
   * except with no project scope, where the row keeps its position (see
   * `markOpen`).
   */
  toggleDone(task: MutableTask, done: boolean): void;
  /** A drag-reorder drop: PATCH the one moved row's precomputed sortOrder. */
  reorderTask(taskId: string, sortOrder: string): void;
  /**
   * File a task into a section (null = loose). Without `sortOrder` it lands at
   * the TOP of the destination — a move by menu is an act of attention, and the
   * row belongs where you'll see it. A drag passes the key it computed from
   * where the row was actually dropped.
   */
  moveTask(task: MutableTask, sectionId: string | null, sortOrder?: string): void;
  /**
   * Delete with undo: hide the row and start the pending-delete window
   * (pendingDelete.ts — the DELETE fires only when the toast's undo window
   * elapses; Undo cancels it, nothing to restore).
   */
  deleteTaskWithUndo(task: { id: string; title: string }): void;
}

export function useTaskMutations(
  client: HitchClient,
  projectId: string | null,
): TaskMutations {
  const queryClient = useQueryClient();
  // This hook's OWN list — the key TodosView/App query under when a
  // project is selected, and ["tasks", {}] (every task the user owns) when
  // there is none. Only the sort-order maths reads it; optimistic writes go to
  // every ["tasks", …] entry instead (see `patchAllTaskLists`).
  const listKey = ["tasks", { projectId: projectId ?? undefined }] as const;
  const taskListFilter = { queryKey: ["tasks"] } as const;

  /**
   * Patch one row across EVERY cached task list, returning the pre-patch
   * snapshot of each entry we could have touched (the rollback payload).
   */
  const patchAllTaskLists = (
    taskId: string,
    fields: TaskPatch & { completedAt?: string | null },
  ) => {
    const previous = queryClient.getQueriesData<MutableTask[]>(taskListFilter);
    queryClient.setQueriesData<MutableTask[]>(taskListFilter, (old) =>
      old?.map((task) => (task.id === taskId ? { ...task, ...fields } : task)),
    );
    return previous;
  };

  /** Undo a `patchAllTaskLists` — restore every entry it snapshotted. */
  const restoreTaskLists = (
    previous: ReturnType<typeof patchAllTaskLists> | undefined,
  ) => {
    for (const [key, data] of previous ?? []) {
      // An entry that held no data was never patched (the updater passes
      // `undefined` straight through), and setQueryData(key, undefined) is a
      // no-op anyway — skip it rather than pretend to restore it.
      if (data !== undefined) queryClient.setQueryData(key, data);
    }
  };

  const patchTask = useMutation({
    mutationFn: async ({ taskId, patch }: {
      taskId: string;
      patch: TaskPatch;
      // The cache projection of `patch` — adds what the server owns but the
      // UI needs now (completedAt: status transitions stamp/clear it
      // server-side; the optimistic stamp is the client clock, reconciled by
      // the settle refetch).
      optimistic: TaskPatch & { completedAt?: string | null };
    }) => {
      const response = await client.tasks[":id"].$patch({
        param: { id: taskId },
        json: patch,
      });
      if (!response.ok) throw new Error(`Failed to update task (${response.status})`);
      return await response.json();
    },
    onMutate: async ({ taskId, optimistic }) => {
      await queryClient.cancelQueries({ queryKey: ["tasks"] });
      return { previous: patchAllTaskLists(taskId, optimistic) };
    },
    onError: (error, _vars, context) => {
      console.error("Task update failed; rolling back", error);
      restoreTaskLists(context?.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // Close-on-done (Decision 3): a done-check also asks the task's live
  // assignments to stop; the reconciler closes the tab and settles them to
  // done. desired_state is the only field the client owns here. Its own
  // invalidation refetches ["assignments"] so the list drops the row out of
  // WORKING/NEEDS YOU once the daemon observes the close.
  const stopAssignment = useMutation({
    mutationFn: async (assignmentId: string) => {
      const response = await client.assignments[":id"].$patch({
        param: { id: assignmentId },
        json: { desiredState: "stopped" },
      });
      // 404 = the assignment is already gone; the goal state holds either way.
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to stop assignment (${response.status})`);
      }
    },
    onError: (error) => {
      console.error("Failed to stop assignment on done-check", error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["assignments"] });
    },
  });

  const deleteTask = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await client.tasks[":id"].$delete({ param: { id: taskId } });
      // 404 = already gone (deleted from another client mid-window) — the
      // outcome we wanted, not an error.
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to delete task (${response.status})`);
      }
    },
    onError: (error) => {
      // The pending window already elapsed, so there's no toast left to lean
      // on; the settle invalidation resurfaces the still-alive row.
      console.error("Task delete failed; the task remains", error);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  // The pending-delete machine. Held once for the workspace's lifetime (the
  // commit callback reaches the current mutation through a ref), so switching
  // projects never drops a running delete window.
  const commitRef = useRef<(taskId: string) => void>(() => {});
  commitRef.current = (taskId) => deleteTask.mutate(taskId);
  const pendingDeletes = useMemo(
    () => createPendingDeleteStore((taskId) => commitRef.current(taskId)),
    [],
  );
  const pendingDeleteIds = useSyncExternalStore(
    pendingDeletes.subscribe,
    pendingDeletes.getSnapshot,
  );

  // Mutation handlers read the CURRENT cache at call time (never a render
  // snapshot), so e.g. two quick unchecks each prepend before the head the
  // previous one just wrote.
  const cachedTasks = () => queryClient.getQueryData<MutableTask[]>(listKey) ?? [];
  // The key shape must match useSections EXACTLY, `undefined` included: React
  // Query's hash drops undefined values but keeps null, so `{projectId: null}`
  // and `{projectId: undefined}` are different cache entries.
  const cachedSections = () =>
    queryClient.getQueryData<SectionRow[]>([
      "sections",
      { projectId: projectId ?? undefined },
    ]) ?? [];

  // The open rows of ONE container, in list order — what a prepend computes
  // against. Order is only ever compared within a container now, so "the top"
  // means the top of the section the row actually lives in.
  const currentContainer = (sectionId: string | null) =>
    tasksInContainer(cachedTasks(), cachedSections(), sectionId);

  function markOpen(task: MutableTask) {
    // Back to the TOP of its OWN section — the row must come back where you'll
    // see it. The task itself is in DONE, so the cached container is already
    // "that container without it".
    //
    // That prepend needs the task's project's cached sections AND its cached
    // container order; a cross-project caller (no `projectId`) has neither —
    // ["sections", {}] is never fetched, so every task would look loose and
    // the "top" would be computed against an unrelated list. A key invented
    // from the wrong ground truth would silently teleport the row inside its
    // own project, so with no project scope we send status alone and leave the
    // row exactly where it sits. Repositioning is unchanged when a project IS
    // scoped.
    if (!projectId) {
      patchTask.mutate({
        taskId: task.id,
        patch: { status: "open" },
        optimistic: { status: "open", completedAt: null },
      });
      return;
    }
    const sortOrder = uncheckSortOrder(currentContainer(task.sectionId ?? null));
    patchTask.mutate({
      taskId: task.id,
      patch: { status: "open", sortOrder },
      optimistic: { status: "open", sortOrder, completedAt: null },
    });
  }

  function markDone(task: MutableTask) {
    patchTask.mutate({
      taskId: task.id,
      patch: { status: "done" },
      optimistic: { status: "done", completedAt: new Date().toISOString() },
    });
    // Close-on-done: stop the task's live assignments (read from the shared
    // ["assignments"] cache the list populates). Undo (markOpen) deliberately
    // does NOT restart them — re-delegation is explicit in the delegate bar.
    const live = assignmentsToStopOnDone(
      queryClient.getQueryData<StoppableAssignment[]>(["assignments"]),
      task.id,
    );
    for (const assignmentId of live) stopAssignment.mutate(assignmentId);
    // Same rationale as V1: a done row drops into a truncated DONE group, so
    // an accidental check is a pain to walk back by hand. Undo re-runs the
    // uncheck, which also re-pins the row to the top of the backlog.
    showUndoableToast({
      message: "Task marked done",
      description: (
        <span className="font-medium text-foreground">{task.title}</span>
      ),
      stack: true,
      undo: () => markOpen(task),
    });
  }

  return {
    pendingDeleteIds,
    toggleDone: (task, done) => {
      if (done) markDone(task);
      else markOpen(task);
    },
    // Drag/section work: offered only by a project-scoped list. It stays
    // callable with no project (the key maths degrades to "top of an empty
    // container" rather than throwing), but no cross-project surface offers it.
    moveTask: (task, sectionId, sortOrder) => {
      const current = task.sectionId ?? null;
      // A drag supplies a key even for a same-container drop; only a MENU move
      // to where the task already is has nothing to do.
      if (current === sectionId && sortOrder === undefined) return;
      const key = sortOrder ?? uncheckSortOrder(currentContainer(sectionId));
      patchTask.mutate({
        taskId: task.id,
        patch: { sectionId, sortOrder: key },
        optimistic: { sectionId, sortOrder: key },
      });
    },
    // Also drag-only: the caller has already computed the key, so this is a
    // plain one-field PATCH and needs no project scope of its own.
    reorderTask: (taskId, sortOrder) => {
      patchTask.mutate({
        taskId,
        patch: { sortOrder },
        optimistic: { sortOrder },
      });
    },
    deleteTaskWithUndo: (task) => {
      pendingDeletes.schedule(task.id);
      showUndoableToast({
        message: "Task deleted",
        description: (
          <span className="font-medium text-foreground">{task.title}</span>
        ),
        stack: true,
        duration: PENDING_DELETE_TOAST_MS,
        undo: () => {
          pendingDeletes.undo(task.id);
        },
      });
    },
  };
}
