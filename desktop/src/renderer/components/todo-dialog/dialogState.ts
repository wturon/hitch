// The Todos tab mounts EXACTLY ONE TodoDialog, driven by this discriminated
// union. It replaced the old pair of state cells (a `todoCaptureOpen` boolean +
// an `openTodoPath` string) that mounted the dialog TWICE — a "capture" instance
// with no live row and an "existing" instance fed by the live query. That fork
// was the architectural bug: after ⌘⏎ the capture instance kept running on its
// own local draft forever, so external writes (the daemon's generated title, a
// chat-link stamp, a footer status, a delete) NEVER reached a capture-born saved
// card until it was closed and reopened.
//
// The invariant this design establishes — write it down because everything here
// exists to hold it: **a document that exists on the server has exactly one
// source of truth — the live query. Local state may only be (a) a draft for a
// document that doesn't exist yet, or (b) unsaved edits merged over the live
// document. No component may hold a fork of a persisted document.**
//
//   • closed — nothing open.
//   • create — a fresh two-stage capture. Nothing exists on the server yet, so
//     the dialog runs on a local draft (allowed: case (a)). `session` is the
//     stable identity token (see below).
//   • edit  — bound to a persisted task at `path`. The dialog is fed the live
//     query row; local state is only unsaved edits merged over it (case (b)).
//
// `session` is a monotonically increasing token minted on every FRESH open
// (Add-a-todo, a list row click, the command palette). It is TodoBody's React
// `key`, so opening a different todo remounts the document model fresh — BUT the
// capture→edit commit (below) KEEPS THE SAME session, so that transition does
// NOT remount. That is the load-bearing subtlety of the whole single-binding
// change: the grow animation (useGrowAnimation's FLIP) and the Lexical editor
// state survive the transform, while the dialog quietly re-binds from its local
// draft to the live query row.
export type TodoDialogState =
  | { mode: "closed" }
  | { mode: "create"; session: number }
  | { mode: "edit"; session: number; path: string };

export const closedState: TodoDialogState = { mode: "closed" };

// A fresh capture (Add-a-todo / `C` / palette "New task").
export function createState(session: number): TodoDialogState {
  return { mode: "create", session };
}

// Open an existing task (list row click / palette "Open task").
export function editState(session: number, path: string): TodoDialogState {
  return { mode: "edit", session, path };
}

// The capture→edit commit: a capture's ⌘⏎ write has just persisted `path`, so
// the dialog now binds to the live query row. Crucially this KEEPS the same
// `session`, so TodoBody is not remounted — the grow animation and editor state
// carry across. A no-op from any other state (an already-edit dialog stays put;
// a closed one never commits).
export function commitState(
  prev: TodoDialogState,
  path: string,
): TodoDialogState {
  return prev.mode === "create"
    ? { mode: "edit", session: prev.session, path }
    : prev;
}

// Close-on-vanish reconciliation: if the edited row is gone (deleted elsewhere,
// or tombstoned by the daemon) once files have loaded, drop to closed. Only
// applies to edit mode — a create-mode capture has nothing persisted to vanish.
// This now also closes capture-born saved cards (they became edit-mode on
// commit): deleting such a task from the list closes its open dialog — an
// intended improvement over the old two-instance model, where a capture-born
// card had no live row and lingered open over a deleted task.
export function reconcileState(
  state: TodoDialogState,
  rowPresent: boolean,
  filesLoaded: boolean,
): TodoDialogState {
  if (state.mode === "edit" && filesLoaded && !rowPresent) return closedState;
  return state;
}
