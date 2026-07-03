// Invariant 3 (robust fallback + loud export): markdown the bridge doesn't model
// no longer refuses to open. On IMPORT, an unsupported construct (code fence,
// raw HTML, image, …) is preserved verbatim in an `UnknownBlockNode` and
// round-trips byte-for-byte — never dropped, never lossily re-rendered. On
// EXPORT, a Lexical node the bridge genuinely can't represent (an underline
// format, a check list) still throws loudly rather than emitting wrong markdown.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { $createListNode } from "@lexical/list";
import { describe, expect, it } from "vitest";

import { exportBuiltTree, importedNodeTypes, roundTrip } from "./harness";

const unsupportedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "unsupported",
);

const fixtures = readdirSync(unsupportedDir)
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("unsupported constructs import as byte-preserving unknown blocks", () => {
  it("has fixtures to test", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("%s becomes an unknown block", (name) => {
    const markdown = readFileSync(join(unsupportedDir, name), "utf8");
    // The unsupported construct lands in at least one UnknownBlockNode …
    expect(importedNodeTypes(markdown)).toContain("unknown-block");
    // … and the whole document still round-trips byte-for-byte.
    expect(roundTrip(markdown)).toBe(markdown);
  });
});

describe("export still throws on nodes the bridge cannot represent", () => {
  it("throws on a text format outside the supported bitmask (underline)", () => {
    expect(() =>
      exportBuiltTree(() => {
        const paragraph = $createParagraphNode();
        // Underline is bit 8 — outside IS_BOLD|IS_ITALIC|IS_STRIKETHROUGH|IS_CODE.
        paragraph.append($createTextNode("underlined").setFormat("underline"));
        $getRoot().append(paragraph);
      }),
    ).toThrow(/Unsupported text format bitmask/);
  });

  it("throws on a check list (no checkbox node in scope)", () => {
    expect(() =>
      exportBuiltTree(() => {
        const list = $createListNode("check");
        $getRoot().append(list);
      }),
    ).toThrow(/Unsupported list type: check/);
  });
});
