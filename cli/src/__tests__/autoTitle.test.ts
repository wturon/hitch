import { describe, expect, it } from "vitest";

import { taskTitleSeed } from "@hitch/shared/taskTitles";

describe("taskTitleSeed", () => {
  it("derives a short provisional title without mutating the body", () => {
    const body =
      "# Investigate [OAuth redirects](https://example.com) after login\n\nFull context.";
    expect(taskTitleSeed(body)).toBe("Investigate OAuth redirects after login");
    expect(body).toContain("https://example.com");
  });

  it("falls back for markdown with no words", () => {
    expect(taskTitleSeed(" # ** ` ")).toBe("Untitled");
  });
});
