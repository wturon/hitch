import { describe, expect, it } from "vitest";

import {
  closedState,
  commitState,
  createState,
  editState,
  reconcileState,
  type TodoDialogState,
} from "../dialogState";

// The single-binding dialog state machine. These transitions are the whole
// architectural fix in miniature: a capture that commits must become an
// edit-mode binding on the same `session` (so the dialog body doesn't remount
// across the transform), and a vanished row must fully reset to closed.
describe("todo dialog state transitions", () => {
  it("open capture / open todo mint create / edit states carrying the session", () => {
    expect(createState(1)).toEqual({ mode: "create", session: 1 });
    expect(editState(2, "tasks/x/task.md")).toEqual({
      mode: "edit",
      session: 2,
      path: "tasks/x/task.md",
    });
  });

  it("commit turns create → edit KEEPING the same session (no remount)", () => {
    const created = createState(7);
    const committed = commitState(created, "tasks/foo/task.md");
    expect(committed).toEqual({
      mode: "edit",
      session: 7, // ← preserved: TodoBody's key is unchanged, so it survives
      path: "tasks/foo/task.md",
    });
  });

  it("commit is a no-op from edit or closed (only a capture commits)", () => {
    const alreadyEdit = editState(3, "tasks/a/task.md");
    expect(commitState(alreadyEdit, "tasks/b/task.md")).toBe(alreadyEdit);
    expect(commitState(closedState, "tasks/b/task.md")).toBe(closedState);
  });

  it("reconcile closes an edit-mode dialog once its row is gone (loaded)", () => {
    const editing = editState(4, "tasks/gone/task.md");
    expect(reconcileState(editing, /*rowPresent*/ false, /*loaded*/ true)).toBe(
      closedState,
    );
  });

  it("reconcile leaves an edit-mode dialog alone while its row is present", () => {
    const editing = editState(5, "tasks/here/task.md");
    expect(reconcileState(editing, true, true)).toBe(editing);
  });

  it("reconcile does NOT close while files are still loading (avoids a flash)", () => {
    const editing = editState(6, "tasks/maybe/task.md");
    expect(reconcileState(editing, false, /*loaded*/ false)).toBe(editing);
  });

  it("reconcile never touches a create-mode capture (nothing persisted to vanish)", () => {
    const capturing: TodoDialogState = createState(8);
    expect(reconcileState(capturing, false, true)).toBe(capturing);
    expect(reconcileState(closedState, false, true)).toBe(closedState);
  });
});
