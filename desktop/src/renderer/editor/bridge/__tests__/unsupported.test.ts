// Invariant 3 (loud failure): inputs containing a construct outside the sandbox
// node set (code fence, image, raw HTML) must throw UnsupportedMarkdownError
// naming the construct — never silently drop content.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { UnsupportedMarkdownError } from "../errors";
import { captureImportError } from "./harness";

const unsupportedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "unsupported",
);

const fixtures = readdirSync(unsupportedDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

// The construct each fixture is expected to name in the thrown error.
const expectedConstruct: Record<string, string> = {
  "code-fence.md": "code",
  "image.md": "image",
  "html-block.md": "html",
};

describe("unsupported constructs throw UnsupportedMarkdownError", () => {
  it("has fixtures to test", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("%s throws and names the construct", (name) => {
    const markdown = readFileSync(join(unsupportedDir, name), "utf8");
    const error = captureImportError(markdown);
    expect(error).toBeInstanceOf(UnsupportedMarkdownError);
    const construct = expectedConstruct[name];
    if (construct) {
      expect((error as UnsupportedMarkdownError).construct).toBe(construct);
    }
  });
});
