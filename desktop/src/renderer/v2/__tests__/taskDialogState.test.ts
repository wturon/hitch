// The single-binding dialog union (V1's dialogState pattern over task ids).
// The load-bearing bit: a capture→edit commit KEEPS the session (no remount);
// everything else mints fresh or reconciles closed.
import { describe, expect, it } from "vitest";

import {
  captureState,
  closedTaskDialog,
  commitTaskState,
  editTaskState,
  reconcileTaskDialog,
} from "../taskDialogState";

describe("commitTaskState", () => {
  it("flips capture→edit keeping the SAME session", () => {
    expect(commitTaskState(captureState(7), "task-1")).toEqual({
      mode: "edit",
      session: 7,
      taskId: "task-1",
    });
  });

  it("is a no-op from closed and edit", () => {
    expect(commitTaskState(closedTaskDialog, "task-1")).toBe(closedTaskDialog);
    const editing = editTaskState(3, "task-9");
    expect(commitTaskState(editing, "task-1")).toBe(editing);
  });
});

describe("reconcileTaskDialog", () => {
  it("closes an edit dialog whose row vanished once tasks loaded", () => {
    const editing = editTaskState(2, "gone");
    expect(reconcileTaskDialog(editing, false, true)).toBe(closedTaskDialog);
  });

  it("waits for the tasks to load before judging absence", () => {
    const editing = editTaskState(2, "maybe");
    expect(reconcileTaskDialog(editing, false, false)).toBe(editing);
  });

  it("leaves capture and closed untouched (nothing persisted to vanish)", () => {
    const capture = captureState(4);
    expect(reconcileTaskDialog(capture, false, true)).toBe(capture);
    expect(reconcileTaskDialog(closedTaskDialog, false, true)).toBe(closedTaskDialog);
  });
});
