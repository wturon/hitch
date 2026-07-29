import { describe, expect, it } from "vitest";

import { autoTitleSeed } from "../commands/tasks.js";

describe("autoTitleSeed", () => {
  it("derives a short provisional title without mutating the body", () => {
    const body =
      "# Investigate [OAuth redirects](https://example.com) after login\n\nFull context.";
    expect(autoTitleSeed(body)).toBe(
      "Investigate OAuth redirects after login Full",
    );
    expect(body).toContain("https://example.com");
  });

  it("falls back for markdown with no words", () => {
    expect(autoTitleSeed(" # ** ` ")).toBe("Untitled");
  });
});
