// The fenced-code bridge boundary. A common ``` fence imports as an editable
// CodeBlockNode; an exotic form the serializer can't reproduce byte-for-byte
// (tilde fence, indented block, over-fenced trivial content) stays unsupported —
// its whole block preserved verbatim in an UnknownBlockNode. This mirrors the
// image boundary suite: the golden/fallback FILES prove round-trip fidelity, this
// suite asserts the node the construct actually lands in, plus that an EDIT
// re-serializes to the right fence.
import { describe, expect, it } from "vitest";

import { exportBuiltTree, importedNodeTypes, roundTrip } from "./harness";
import {
  $createCodeBlockNode,
  $isCodeBlockNode,
} from "../../nodes/CodeBlockNode";
import { $getRoot, $nodesOfType } from "lexical";
import { CodeBlockNode } from "../../nodes/CodeBlockNode";

describe("code block bridge boundary", () => {
  it("imports a common fence as an editable code block, not an unknown block", () => {
    const types = importedNodeTypes("```ts\nconst x = 1;\n```\n");
    expect(types).toContain("code-block");
    expect(types).not.toContain("unknown-block");
  });

  it("preserves an info-string meta after the language on round-trip", () => {
    // `title=x` is meta the UI never shows but must survive verbatim.
    const md = "```ts title=x\nconst y = 2;\n```\n";
    expect(importedNodeTypes(md)).toContain("code-block");
    expect(roundTrip(md)).toBe(md);
  });

  it.each([
    ["tilde fence", "~~~js\nconst x = 1;\n~~~\n"],
    ["indented code", "    const x = 1;\n    const y = 2;\n"],
    ["4-backtick trivial", "````\ntrivial\n````\n"],
  ])("keeps an exotic fence (%s) unsupported and byte-exact", (_name, md) => {
    const types = importedNodeTypes(md);
    expect(types).toContain("unknown-block");
    expect(types).not.toContain("code-block");
    expect(roundTrip(md)).toBe(md);
  });

  it("an empty fence round-trips as a lang-less code block", () => {
    const md = "```\n```\n";
    expect(importedNodeTypes(md)).toContain("code-block");
    expect(roundTrip(md)).toBe(md);
  });
});

describe("code block export reflects edits", () => {
  it("setCode changes the fence body", () => {
    const out = exportBuiltTree(() => {
      $getRoot().append($createCodeBlockNode("old();", "ts", null));
      const node = $nodesOfType(CodeBlockNode)[0];
      if ($isCodeBlockNode(node)) node.setCode("fresh();\nmore();");
    });
    expect(out).toBe("```ts\nfresh();\nmore();\n```\n");
  });

  it("setLanguage changes the fence info string", () => {
    const out = exportBuiltTree(() => {
      $getRoot().append($createCodeBlockNode("pass", "python", null));
      const node = $nodesOfType(CodeBlockNode)[0];
      if ($isCodeBlockNode(node)) node.setLanguage("bash");
    });
    expect(out).toBe("```bash\npass\n```\n");
  });

  it("an empty language exports a lang-less fence", () => {
    const out = exportBuiltTree(() => {
      $getRoot().append($createCodeBlockNode("plain", "", null));
    });
    expect(out).toBe("```\nplain\n```\n");
  });
});
