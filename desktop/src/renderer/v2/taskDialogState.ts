// The V2 shell mounts EXACTLY ONE TaskDialogV2, driven by this discriminated
// union — a direct port of V1's TodoDialogState PATTERN (components/todo-dialog/
// dialogState.ts), not its file model: V2 tasks are server rows addressed by
// id, so `edit` carries a taskId instead of a tasks/<slug>/task.md path.
//
// The invariant the pattern holds (write it down — everything here exists for
// it): **a task that exists on the server has exactly one source of truth — the
// live query. Local state may only be (a) a draft for a task that doesn't exist
// yet, or (b) unsaved edits merged over the live row. No component may hold a
// fork of a persisted task.**
//
//   • closed  — nothing open.
//   • capture — the two-stage capture card. Nothing exists on the server yet,
//     so the dialog runs on a local draft (allowed: case (a)).
//   • edit    — bound to a persisted task by id. The dialog is fed the live
//     query row; local state is only unsaved edits over it (case (b)).
//
// `session` is a monotonically increasing token minted on every FRESH open
// (the add-row, `C`, a list row click). It is the dialog body's React key, so
// opening a different task remounts the document model fresh — BUT the
// capture→edit commit (below) KEEPS THE SAME session, so that transition does
// NOT remount. That is the load-bearing subtlety carried over from V1: the
// capture→saved grow animation and the Lexical editor state survive the
// transform, while the dialog quietly re-binds from its local draft to the
// live query row.
export type TaskDialogState =
  | { mode: "closed" }
  | { mode: "capture"; session: number }
  | { mode: "edit"; session: number; taskId: string };

export const closedTaskDialog: TaskDialogState = { mode: "closed" };

// A fresh capture (the add-row / `C`).
export function captureState(session: number): TaskDialogState {
  return { mode: "capture", session };
}

// Open an existing task (list row click).
export function editTaskState(session: number, taskId: string): TaskDialogState {
  return { mode: "edit", session, taskId };
}

// The capture→edit commit: the capture's ⌘⏎ POST just persisted the task, so
// the dialog now binds to the live query row. Crucially this KEEPS the same
// `session`, so the dialog body is not remounted — the grow animation and
// editor state carry across. A no-op from any other state (an already-edit
// dialog stays put; a closed one never commits).
export function commitTaskState(
  prev: TaskDialogState,
  taskId: string,
): TaskDialogState {
  return prev.mode === "capture"
    ? { mode: "edit", session: prev.session, taskId }
    : prev;
}

// Close-on-vanish reconciliation: if the edited task is gone (deleted from
// another client) once the task list has loaded, drop to closed. Only applies
// to edit mode — a capture has nothing persisted to vanish. Like V1, this also
// closes a capture-born card (it became edit-mode on commit) whose task is
// deleted elsewhere while the dialog is open.
export function reconcileTaskDialog(
  state: TaskDialogState,
  rowPresent: boolean,
  tasksLoaded: boolean,
): TaskDialogState {
  if (state.mode === "edit" && tasksLoaded && !rowPresent) return closedTaskDialog;
  return state;
}
