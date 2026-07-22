// The V2 delete-with-undo state machine (M2 PR 4). V1's undo-delete restores a
// snapshot after the fact (tombstone immediately, re-upsert the file bytes on
// undo) — possible there because a task IS its file content. A V2 re-POST
// could not be lossless (new uuid, severed tag links), so V2 inverts the
// order: deleting a task only marks it PENDING — hidden from the list, still
// on the server — and the real DELETE fires when the undo window elapses.
// Undo just cancels the timer; nothing to restore. Fail-open by design: if
// the app quits mid-window the DELETE never fires and the task survives.
//
// Pure and framework-free (injected timers via the standard globals, commit
// via callback) so the machine unit-tests with fake timers; the React side
// subscribes through the useSyncExternalStore-shaped snapshot/subscribe pair.

/** How long the undo toast shows — sonner's V1 default, kept in lockstep. */
export const PENDING_DELETE_TOAST_MS = 6000;
// The DELETE commits a beat AFTER the toast leaves the screen, so "toast still
// visible" always implies "undo still possible" — the race between the toast's
// auto-close and the commit timer can never invert.
const COMMIT_GRACE_MS = 500;
export const PENDING_DELETE_COMMIT_MS = PENDING_DELETE_TOAST_MS + COMMIT_GRACE_MS;

export interface PendingDeleteStore {
  /** Start a pending delete. No-op if the task is already pending. */
  schedule(taskId: string): void;
  /**
   * Cancel a pending delete (the toast's Undo). Returns false when the task
   * wasn't pending — e.g. the window already elapsed and the DELETE committed.
   */
  undo(taskId: string): boolean;
  /** The currently-pending task ids. Stable reference between changes. */
  getSnapshot(): ReadonlySet<string>;
  subscribe(listener: () => void): () => void;
}

export function createPendingDeleteStore(
  commit: (taskId: string) => void,
  timeoutMs: number = PENDING_DELETE_COMMIT_MS,
): PendingDeleteStore {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();
  // Recomputed only on change so useSyncExternalStore sees a stable snapshot.
  let snapshot: ReadonlySet<string> = new Set();

  function changed() {
    snapshot = new Set(timers.keys());
    for (const listener of listeners) listener();
  }

  return {
    schedule(taskId) {
      if (timers.has(taskId)) return;
      timers.set(
        taskId,
        setTimeout(() => {
          timers.delete(taskId);
          changed();
          commit(taskId);
        }, timeoutMs),
      );
      changed();
    },
    undo(taskId) {
      const timer = timers.get(taskId);
      if (timer === undefined) return false;
      clearTimeout(timer);
      timers.delete(taskId);
      changed();
      return true;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
