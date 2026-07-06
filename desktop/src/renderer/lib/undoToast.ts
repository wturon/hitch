"use client";

// A single global "undo register" layered on top of sonner. At most one
// undoable action is live at a time: showUndoableToast replaces any previous
// one (it reuses a fixed toast id), and the ⌘Z hotkey (installed by
// useUndoHotkey) runs whatever is currently in the slot.
//
// The slot is cleared the moment the toast leaves the screen — auto-close,
// manual dismiss, or after running the undo. So ⌘Z is inert unless the toast is
// visible. That "visible contract" is the whole design: the hotkey only ever
// undoes the thing you can currently see, which keeps it unsurprising and means
// we never need a persistent multi-level undo stack.
//
// We reach for this only for actions that are hard to walk back by hand —
// completing a task (the row jumps to the bottom of a truncated DONE group) and
// deleting a task/note (gone from the list). Actions whose result is visible in
// place don't get a toast; a "success toast on everything" pattern would just
// bury the two that matter.

import { useEffect } from "react";
import { toast } from "sonner";

// One id for every undoable toast: reusing it means a second undoable action
// replaces the first on screen (and in the slot below) rather than stacking.
const UNDO_TOAST_ID = "undoable-action";

let pendingUndo: (() => void) | null = null;

function clearSlot() {
  pendingUndo = null;
}

// Run the pending undo (if any) and take the toast down. Idempotent: clearing
// the slot before invoking means a second trigger (⌘Z after the button, or the
// reverse) is a no-op.
function runUndo() {
  const undo = pendingUndo;
  pendingUndo = null;
  toast.dismiss(UNDO_TOAST_ID);
  undo?.();
}

export function showUndoableToast({
  message,
  description,
  undo,
  duration = 6000,
}: {
  message: string;
  description?: string;
  undo: () => void;
  duration?: number;
}) {
  pendingUndo = undo;
  toast(message, {
    id: UNDO_TOAST_ID,
    description,
    duration,
    action: { label: "Undo", onClick: runUndo },
    // Clear the slot whenever the toast leaves for a reason other than an undo
    // we already handled — this is what makes ⌘Z bound only while it shows.
    onAutoClose: clearSlot,
    onDismiss: clearSlot,
  });
}

// The ⌘Z (or Ctrl+Z) hotkey. Mount once near the app root. Fires the pending
// undo only while a toast is up; otherwise it yields the chord back to whatever
// would normally handle it. It also defers to native undo where ⌘Z already
// means something — a focused text field or the rich-text editor — mirroring
// useListKeyboardNav's target guard so typing-undo is never hijacked.
export function useUndoHotkey() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isUndoChord =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "z";
      if (!isUndoChord) return;
      // Visible contract: nothing on screen to undo → let the chord through.
      if (!pendingUndo) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest('input,textarea,select,[contenteditable="true"]')
      ) {
        return;
      }
      e.preventDefault();
      runUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
