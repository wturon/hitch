"use client";

// A small global undo register layered on top of sonner. Most undoable actions
// reuse a fixed toast id so repeated deletes still replace the previous toast;
// callers can opt into stacked toasts for repeated actions where each event
// needs its own visible undo affordance.
//
// A toast is removed from the register the moment it leaves the screen —
// auto-close, manual dismiss, or after running the undo. So ⌘Z is inert unless
// at least one undo toast is visible. The hotkey targets the newest visible undo
// toast, matching what Sonner visually places at the front of the stack.
//
// We reach for this only for actions that are hard to walk back by hand —
// completing a task (the row jumps to the bottom of a truncated DONE group) and
// deleting a task/note (gone from the list). Actions whose result is visible in
// place don't get a toast; a "success toast on everything" pattern would just
// bury the two that matter.

import { useEffect, type ReactNode } from "react";
import { toast } from "sonner";

const UNDO_TOAST_ID = "undoable-action";

let nextUndoToastId = 0;
const pendingUndos = new Map<string | number, () => void>();
let visibleUndoIds: Array<string | number> = [];

function removeUndo(id: string | number) {
  pendingUndos.delete(id);
  visibleUndoIds = visibleUndoIds.filter((visibleId) => visibleId !== id);
}

function latestUndoId() {
  return visibleUndoIds.at(-1) ?? null;
}

// Run the selected undo and take that toast down. Idempotent: clearing before
// invoking means a second trigger (⌘Z after the button, or the reverse) is a
// no-op.
function runUndo(id: string | number) {
  const undo = pendingUndos.get(id);
  removeUndo(id);
  toast.dismiss(id);
  undo?.();
}

export function showUndoableToast({
  message,
  description,
  icon,
  undo,
  duration = 6000,
  stack = false,
}: {
  message: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  undo: () => void;
  duration?: number;
  stack?: boolean;
}) {
  const id = stack ? `undoable-action-${++nextUndoToastId}` : UNDO_TOAST_ID;
  removeUndo(id);
  pendingUndos.set(id, undo);
  visibleUndoIds.push(id);
  toast(message, {
    id,
    description,
    icon,
    duration,
    action: { label: "Undo", onClick: () => runUndo(id) },
    // Clear the slot whenever the toast leaves for a reason other than an undo
    // we already handled — this is what makes ⌘Z bound only while it shows.
    onAutoClose: () => removeUndo(id),
    onDismiss: () => removeUndo(id),
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
      const id = latestUndoId();
      if (!id) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.closest('input,textarea,select,[contenteditable="true"]')
      ) {
        return;
      }
      e.preventDefault();
      runUndo(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
