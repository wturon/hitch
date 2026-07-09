import { describe, expect, it } from "vitest";

import {
  MODELS_BY_HARNESS,
  defaultModel,
  defaultReasoning,
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
