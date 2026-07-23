import { useMemo, useRef, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { HitchClient } from "@/lib/server/client";
import { showUndoableToast } from "@/lib/undoToast";
import { assignmentsToStopOnDone, type StoppableAssignment } from "./delegation";
import { uncheckSortOrder } from "./listMutations";
import {
  createPendingDeleteStore,
  PENDING_DELETE_TOAST_MS,
} from "./pendingDelete";
import { deriveTaskGroups, type TaskRow } from "./todoGroups";

// The V2 list mutations (M2 PR 4): check/uncheck, drag reorder, delete with
// undo — every server write the list makes, owned by ONE hook instance in the
// shell (AppV2) so the list, the dialog ⋯ menu and the keyboard shortcuts all
// route through the same handlers, the same optimistic cache and the same
// pending-delete set (V1's "row and dialog share one code path" rule).
//
// Optimistic updates follow the TkDodo onMutate pattern: cancel in-flight
// ["tasks"] queries (so a refetch that raced the click can't clobber the
// optimistic rows when it lands), snapshot the list, patch the one row,
// rollback on error, invalidate on settle. The WS invalidation arriving after
// settle just refetches server truth — by then identical to the cache.

// What the mutations need from a cached task row — a structural subset of the
// GET /tasks response (spreads keep the fields we don't model, e.g. tagIds).
export interface MutableTask extends TaskRow {
  title: string;
}

interface TaskPatch {
  status?: "open" | "done";
  sortOrder?: string;
}

export interface TaskMutations {
  /** Tasks hidden from the list while their delete window runs. */
  pendingDeleteIds: ReadonlySet<string>;
  /**
   * Check/uncheck. Checking PATCHes status:"done" (the server stamps
   * completed_at) and offers an undo toast; unchecking returns the task to
   * the TOP of the backlog (fractional-index prepend, client-computed).
   */
  toggleDone(task: MutableTask, done: boolean): void;
  /** A drag-reorder drop: PATCH the one moved row's precomputed sortOrder. */
  reorderTask(taskId: string, sortOrder: string): void;
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
  // The SAME key TodosViewV2/AppV2 query under, so the optimistic patches land
  // in the one shared cache entry.
  const listKey = ["tasks", { projectId: projectId ?? undefined }] as const;

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
      const previous = queryClient.getQueryData<MutableTask[]>(listKey);
      queryClient.setQueryData<MutableTask[]>(listKey, (old) =>
        old?.map((task) =>
          task.id === taskId ? { ...task, ...optimistic } : task,
        ),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      console.error("Task update failed; rolling back", error);
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
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
  const currentBacklog = () =>
    deriveTaskGroups(
      queryClient.getQueryData<MutableTask[]>(listKey) ?? [],
    ).backlog;

  function markOpen(task: MutableTask) {
    // Back to the TOP of the backlog — the row must come back where you'll
    // see it. The task itself is in DONE, so the cached backlog is already
    // "the backlog without it".
    const sortOrder = uncheckSortOrder(currentBacklog());
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
      if (!projectId) return;
      if (done) markDone(task);
      else markOpen(task);
    },
    reorderTask: (taskId, sortOrder) => {
      if (!projectId) return;
      patchTask.mutate({
        taskId,
        patch: { sortOrder },
        optimistic: { sortOrder },
      });
    },
    deleteTaskWithUndo: (task) => {
      if (!projectId) return;
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
