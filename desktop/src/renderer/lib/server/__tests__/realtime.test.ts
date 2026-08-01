import { describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";

import type { HitchServerBridge } from "../bridge";
import { startRealtimeInvalidation } from "../realtime";

// A hand-rolled bridge whose WS callbacks the test fires directly, plus a
// stubbed QueryClient — realtime.ts only ever calls invalidateQueries.
function makeHarness() {
  let onMessage: ((message: unknown) => void) | undefined;
  let onOpen: (() => void) | undefined;
  const offMessage = vi.fn();
  const offOpen = vi.fn();
  const bridge = {
    onWsMessage: (callback: (message: unknown) => void) => {
      onMessage = callback;
      return offMessage;
    },
    onWsOpen: (callback: () => void) => {
      onOpen = callback;
      return offOpen;
    },
  } as unknown as HitchServerBridge;
  const invalidateQueries = vi.fn();
  const queryClient = { invalidateQueries } as unknown as QueryClient;
  const stop = startRealtimeInvalidation(queryClient, bridge);
  return {
    invalidateQueries,
    stop,
    offMessage,
    offOpen,
    message: (payload: unknown) => onMessage?.(payload),
    open: () => onOpen?.(),
  };
}

describe("startRealtimeInvalidation", () => {
  it("fans an invalidate frame out to its table's query key", () => {
    const harness = makeHarness();
    harness.message({ type: "invalidate", table: "projects", id: "p1" });
    expect(harness.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: ["projects"],
    });
  });

  it("maps task_tags' composite payload onto the tasks key", () => {
    const harness = makeHarness();
    harness.message({
      type: "invalidate",
      table: "task_tags",
      task_id: "t1",
      tag_id: "g1",
    });
    expect(harness.invalidateQueries).toHaveBeenCalledExactlyOnceWith({
      queryKey: ["tasks"],
    });
  });

  it("fans an assignments frame out to BOTH its keys", () => {
    // /chats denormalises the task each chat is committed to, and that fact
    // lives in assignments — so an assignments NOTIFY has to refresh the chat
    // reads too, or the link picker keeps offering a chat that is spoken for.
    const harness = makeHarness();
    harness.message({ type: "invalidate", table: "assignments", id: "a1" });
    expect(harness.invalidateQueries).toHaveBeenCalledTimes(2);
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["assignments"] });
    expect(harness.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["chats"] });
  });

  it("invalidates everything (no key) on each ws open", () => {
    const harness = makeHarness();
    harness.open();
    expect(harness.invalidateQueries).toHaveBeenCalledExactlyOnceWith();
  });

  it("ignores event frames, unknown tables, and malformed frames", () => {
    const harness = makeHarness();
    harness.message({ type: "event", event: "focus", payload: {} });
    harness.message({ type: "invalidate", table: "session", id: "s1" });
    harness.message({ type: "invalidate" });
    harness.message("garbage");
    harness.message(null);
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
  });

  it("unsubscribes both listeners on stop", () => {
    const harness = makeHarness();
    harness.stop();
    expect(harness.offMessage).toHaveBeenCalledOnce();
    expect(harness.offOpen).toHaveBeenCalledOnce();
  });
});
