// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROMPT_TEMPLATE_FRAMING } from "@hitch/shared";

import {
  MODELS_BY_HARNESS,
  defaultModel,
  defaultReasoning,
  loadCustomPrompts,
  modelLabel,
  reasoningOptions,
} from "../chat";

describe("Codex model catalog", () => {
  it("defaults new Codex launches to GPT-5.6 Sol", () => {
    expect(defaultModel("codex")).toBe("gpt-5.6-sol");
    expect(modelLabel("codex", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(defaultReasoning("codex", "gpt-5.6-sol")).toBe("medium");
  });

  it("exposes the GPT-5.6 family in the model picker", () => {
    expect(MODELS_BY_HARNESS.codex.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]),
    );
  });

  it("uses GPT-5.6 reasoning options including none and max", () => {
    expect(reasoningOptions("codex", "gpt-5.6-sol").map((option) => option.id)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

// Prompts saved before templates existed are instruction-only and assumed a
// preamble would be prepended. Nothing is prepended now, so left alone they'd
// launch an agent with NO task context — silently. That's the failure this
// migration exists to prevent.
describe("legacy custom-prompt migration", () => {
  function withBridge(stored: Array<{ id: string; name: string; body: string }>) {
    const setStartingPrompts = vi.fn().mockImplementation((p) => Promise.resolve(p));
    (window as unknown as { hitchDaemon?: unknown }).hitchDaemon = {
      getStartingPrompts: vi.fn().mockResolvedValue(stored),
      setStartingPrompts,
    };
    return setStartingPrompts;
  }

  afterEach(() => {
    delete (window as unknown as { hitchDaemon?: unknown }).hitchDaemon;
    vi.restoreAllMocks();
  });

  it("puts the framing back on a variable-free prompt, and persists it", async () => {
    const persist = withBridge([{ id: "c1", name: "Mine", body: "Write tests." }]);
    const [migrated] = await loadCustomPrompts();

    expect(migrated.body).toBe(`${PROMPT_TEMPLATE_FRAMING}\n\nWrite tests.`);
    expect(migrated.body).toContain("$TASK_BODY");
    // The user's own words survive verbatim at the end.
    expect(migrated.body.endsWith("Write tests.")).toBe(true);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("leaves an already-templated prompt alone and writes nothing", async () => {
    const body = "Do $TASK_TITLE my way.";
    const persist = withBridge([{ id: "c2", name: "Templated", body }]);
    const [prompt] = await loadCustomPrompts();

    expect(prompt.body).toBe(body);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not invent a prompt for an empty body", async () => {
    const persist = withBridge([{ id: "c3", name: "Blank", body: "" }]);
    const [prompt] = await loadCustomPrompts();

    expect(prompt.body).toBe("");
    expect(persist).not.toHaveBeenCalled();
  });
});
