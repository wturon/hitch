// The delete-with-undo state machine: a scheduled delete hides now, COMMITS
// only when its window elapses, and an undo cancels it entirely (V2's undo
// restores nothing — the DELETE simply never fires).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPendingDeleteStore,
  PENDING_DELETE_COMMIT_MS,
  PENDING_DELETE_TOAST_MS,
} from "../pendingDelete";

describe("createPendingDeleteStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedule marks the task pending; the commit waits for the window", () => {
    const commit = vi.fn();
    const store = createPendingDeleteStore(commit, 1000);
    store.schedule("t1");
    expect(store.getSnapshot().has("t1")).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it("the window elapsing commits exactly once and clears the pending id", () => {
    const commit = vi.fn();
    const store = createPendingDeleteStore(commit, 1000);
    store.schedule("t1");
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledExactlyOnceWith("t1");
    expect(store.getSnapshot().has("t1")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("undo cancels: the id clears and the commit NEVER fires", () => {
    const commit = vi.fn();
    const store = createPendingDeleteStore(commit, 1000);
    store.schedule("t1");
    expect(store.undo("t1")).toBe(true);
    expect(store.getSnapshot().has("t1")).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(commit).not.toHaveBeenCalled();
  });

  it("undo after the window already committed reports false", () => {
    const commit = vi.fn();
    const store = createPendingDeleteStore(commit, 1000);
    store.schedule("t1");
    vi.advanceTimersByTime(1000);
    expect(store.undo("t1")).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("re-scheduling a pending id is a no-op (the original window stands)", () => {
    const commit = vi.fn();
    const store = createPendingDeleteStore(commit, 1000);
    store.schedule("t1");
    vi.advanceTimersByTime(600);
    store.schedule("t1"); // must NOT reset the timer
    vi.advanceTimersByTime(400);
    expect(commit).toHaveBeenCalledExactlyOnceWith("t1");
  });

  it("windows run independently per task", () => {
    const commit = vi.fn();
    const store = createPendingDeleteStore(commit, 1000);
    store.schedule("t1");
    vi.advanceTimersByTime(500);
    store.schedule("t2");
    store.undo("t1");
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledExactlyOnceWith("t2");
    expect(store.getSnapshot().size).toBe(0);
  });

  it("notifies subscribers on every transition, with a stable snapshot between", () => {
    const store = createPendingDeleteStore(() => {}, 1000);
    const listener = vi.fn();
    store.subscribe(listener);
    store.schedule("t1");
    expect(listener).toHaveBeenCalledTimes(1);
    const snap = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snap); // stable until the next change
    store.undo("t1");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).not.toBe(snap);
  });

  it("the commit window outlasts the toast (undo visible ⇒ undo possible)", () => {
    expect(PENDING_DELETE_COMMIT_MS).toBeGreaterThan(PENDING_DELETE_TOAST_MS);
  });
});
