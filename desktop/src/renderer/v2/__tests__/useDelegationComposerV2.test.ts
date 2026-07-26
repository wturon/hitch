// @vitest-environment jsdom
//
// The V2 delegate composer state machine (ported shape of V1's
// useDelegationComposer): last-harness seed, preset selection, and the phase
// latch that guards against a double-launch. The chrome (Selects, textarea) is
// exercised by PR 6's acceptance script — here we pin the pure state machine.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { BUILTIN_STARTING_PROMPTS } from "@/lib/chat";
import { defaultModelFor, defaultReasoningFor } from "../delegation";
import { useDelegationComposerV2 } from "../useDelegationComposerV2";

// Historical key name (once held a bare harness; now holds the {harness, model,
// effort} JSON blob, with a legacy bare-harness string still read on upgrade).
const LAST_HARNESS_KEY = "hitch:v2:last-harness";

// A no-op consumer arm — the ⌘⏎ listener is off, so start() is only exercised
// through direct calls here.
function render(
  onStart: (params: {
    harness: string;
    model: string;
    effort: string;
    promptTemplate: string;
  }) => Promise<void> | void,
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

describe("agent selection", () => {
  it("seeds model + effort from the catalog default", () => {
    const { result } = render(vi.fn());
    const model = defaultModelFor("claude");
    expect(result.current.model).toBe(model);
    expect(result.current.effort).toBe(defaultReasoningFor("claude", model));
  });

  it("chooseAgent sets harness+model and resets effort to the model default", () => {
    const { result } = render(vi.fn());
    const codexModel = defaultModelFor("codex");
    act(() => result.current.chooseAgent(`codex|${codexModel}`));
    expect(result.current.harness).toBe("codex");
    expect(result.current.model).toBe(codexModel);
    expect(result.current.effort).toBe(defaultReasoningFor("codex", codexModel));
  });

  it("setHarness switches harness and resets model + effort to that harness's defaults", () => {
    const { result } = render(vi.fn());
    act(() => result.current.setHarness("codex"));
    const model = defaultModelFor("codex");
    expect(result.current.harness).toBe("codex");
    expect(result.current.model).toBe(model);
    expect(result.current.effort).toBe(defaultReasoningFor("codex", model));
  });

  it("setEffort overrides the effort without touching harness/model", () => {
    const { result } = render(vi.fn());
    act(() => result.current.setEffort("low"));
    expect(result.current.effort).toBe("low");
    expect(result.current.harness).toBe("claude");
    expect(result.current.model).toBe(defaultModelFor("claude"));
  });
});

describe("choosePreset", () => {
  it("refills the prompt text from the picked preset", () => {
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
  it("runs idle → submitted, calls onStart, and remembers the agent triple", async () => {
    // Legacy bare-harness seed → harness codex, default model + effort.
    window.localStorage.setItem(LAST_HARNESS_KEY, "codex");
    const model = defaultModelFor("codex");
    const effort = defaultReasoningFor("codex", model);
    const onStart = vi.fn().mockResolvedValue(undefined);
    const { result } = render(onStart);

    await act(async () => {
      await result.current.start();
    });

    expect(onStart).toHaveBeenCalledWith({
      harness: "codex",
      model,
      effort,
      // The WHOLE template goes over the wire — the bar composes nothing.
      promptTemplate: BUILTIN_STARTING_PROMPTS[0].body,
    });
    expect(result.current.phase).toBe("submitted");
    // The full triple is persisted as a JSON blob now.
    expect(
      JSON.parse(window.localStorage.getItem(LAST_HARNESS_KEY)!),
    ).toEqual({ harness: "codex", model, effort });
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

// An empty prompt used to be impossible: a blank instruction still got the
// preamble. Now the textarea IS the whole prompt, so clearing it would launch
// an agent with nothing to do.
describe("blank prompts can't be delegated", () => {
  it("blocks start() and reports canSubmit=false when the prompt is empty", async () => {
    const onStart = vi.fn().mockResolvedValue(undefined);
    const { result } = render(onStart);
    expect(result.current.canSubmit).toBe(true);

    act(() => result.current.setPrompt("   \n  "));
    expect(result.current.canSubmit).toBe(false);
    await act(async () => {
      await result.current.start();
    });
    expect(onStart).not.toHaveBeenCalled();
    // Not latched — the user can type something and try again.
    expect(result.current.phase).toBe("idle");
  });

  it("canSubmit is false when the consumer says we can't start at all", () => {
    const { result } = render(vi.fn(), false);
    expect(result.current.canSubmit).toBe(false);
  });
});

// ⌘⏎ fires start() from a window keydown handler — there is nowhere for the
// caller to catch, so a failed delegate there used to be totally silent (and an
// unhandled rejection). The message lives on the composer for that reason.
describe("failed delegates are reported, not swallowed", () => {
  it("records the error message and clears it on the next attempt", async () => {
    const onStart = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to delegate (400)"))
      .mockResolvedValueOnce(undefined);
    const { result } = render(onStart);
    expect(result.current.error).toBeNull();

    await act(async () => {
      await expect(result.current.start()).rejects.toThrow();
    });
    expect(result.current.error).toBe("Failed to delegate (400)");

    // A retry clears the stale message rather than leaving it under a success.
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.phase).toBe("submitted");
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    const onStart = vi.fn().mockRejectedValue("nope");
    const { result } = render(onStart);
    await act(async () => {
      await expect(result.current.start()).rejects.toBeTruthy();
    });
    expect(result.current.error).toBe("Failed to delegate");
  });
});
