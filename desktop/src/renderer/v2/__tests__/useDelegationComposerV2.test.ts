// @vitest-environment jsdom
//
// The V2 delegate composer state machine (ported shape of V1's
// useDelegationComposer): last-harness seed, preset selection, and the phase
// latch that guards against a double-launch. The chrome (Selects, textarea) is
// exercised by PR 6's acceptance script — here we pin the pure state machine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { BUILTIN_STARTING_PROMPTS } from "@/lib/chat";
import { useDelegationComposerV2 } from "../useDelegationComposerV2";

const LAST_HARNESS_KEY = "hitch:v2:last-harness";

// A no-op consumer arm — the ⌘⏎ listener is off, so start() is only exercised
// through direct calls here.
function render(
  onStart: (params: { harness: string; prompt: string }) => Promise<void> | void,
  canStart = true,
) {
  return renderHook(() =>
    useDelegationComposerV2({ canStart, keyboardArmed: false, onStart }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("seeding", () => {
  it("defaults to claude when nothing is stored", () => {
    const { result } = render(vi.fn());
    expect(result.current.harness).toBe("claude");
  });

  it("seeds the harness from the last V2 delegation", () => {
    window.localStorage.setItem(LAST_HARNESS_KEY, "codex");
    const { result } = render(vi.fn());
    expect(result.current.harness).toBe("codex");
  });

  it("starts on the first built-in preset's body", () => {
    const { result } = render(vi.fn());
    expect(result.current.promptId).toBe(BUILTIN_STARTING_PROMPTS[0].id);
    expect(result.current.prompt).toBe(BUILTIN_STARTING_PROMPTS[0].body);
  });
});

describe("choosePreset", () => {
  it("refills the instruction text from the picked preset", () => {
    const second = BUILTIN_STARTING_PROMPTS[1];
    const { result } = render(vi.fn());
    act(() => result.current.choosePreset(second.id));
    expect(result.current.promptId).toBe(second.id);
    expect(result.current.prompt).toBe(second.body);
  });

  it("ignores an unknown preset id", () => {
    const { result } = render(vi.fn());
    const before = result.current.prompt;
    act(() => result.current.choosePreset("no-such-preset"));
    expect(result.current.prompt).toBe(before);
  });
});

describe("start", () => {
  it("runs idle → submitted, calls onStart, and remembers the harness", async () => {
    window.localStorage.setItem(LAST_HARNESS_KEY, "codex");
    const onStart = vi.fn().mockResolvedValue(undefined);
    const { result } = render(onStart);

    await act(async () => {
      await result.current.start();
    });

    expect(onStart).toHaveBeenCalledWith({
      harness: "codex",
      prompt: BUILTIN_STARTING_PROMPTS[0].body,
    });
    expect(result.current.phase).toBe("submitted");
    expect(window.localStorage.getItem(LAST_HARNESS_KEY)).toBe("codex");
  });

  it("is a no-op while canStart is false", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    const { result } = render(onStart, false);
    await act(async () => {
      await result.current.start();
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("stays latched: a second start after submit does not fire again", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    const { result } = render(onStart);
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await result.current.start();
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe("submitted");
  });

  it("unlatches and rethrows when onStart fails, so a retry can fire", async () => {
    const onStart = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const { result } = render(onStart);

    await act(async () => {
      await expect(result.current.start()).rejects.toThrow("boom");
    });
    expect(result.current.phase).toBe("idle");

    // The unlatch means a follow-up delegate is allowed.
    await act(async () => {
      await result.current.start();
    });
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(result.current.phase).toBe("submitted");
  });

  it("does not persist the harness when the launch fails", async () => {
    window.localStorage.setItem(LAST_HARNESS_KEY, "claude");
    const onStart = vi.fn().mockRejectedValue(new Error("boom"));
    const { result } = render(onStart);
    act(() => result.current.setHarness("codex"));
    await act(async () => {
      await expect(result.current.start()).rejects.toThrow("boom");
    });
    // Still the pre-start value — a failed launch never rewrites the seed.
    expect(window.localStorage.getItem(LAST_HARNESS_KEY)).toBe("claude");
  });
});

describe("custom prompts bridge", () => {
  it("loads customs from the bridge and appends them to the built-ins", async () => {
    const custom = {
      id: "custom-1",
      name: "My prompt",
      body: "Custom body",
      includeTaskRef: true,
    };
    (window as unknown as { hitchDaemon?: unknown }).hitchDaemon = {
      getStartingPrompts: vi.fn().mockResolvedValue([custom]),
    };
    try {
      const { result } = render(vi.fn());
      await waitFor(() => {
        expect(result.current.prompts.some((p) => p.id === "custom-1")).toBe(true);
      });
      expect(result.current.prompts[0].id).toBe(BUILTIN_STARTING_PROMPTS[0].id);
    } finally {
      delete (window as unknown as { hitchDaemon?: unknown }).hitchDaemon;
    }
  });
});
