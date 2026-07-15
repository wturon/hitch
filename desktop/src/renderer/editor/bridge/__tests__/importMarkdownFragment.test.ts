// $importMarkdownFragment: markdown → detached nodes for caret insertion (the
// snippet feature). Same fidelity contract as the whole-document importer —
// importable constructs become editable nodes, anything exotic becomes a
// verbatim UnknownBlockNode, nothing is dropped — but the root is never
// cleared. Each test attaches the returned nodes and exports the document, so
// the assertions cover both the node shapes AND that the inserted fragment
// serializes back to the snippet's own markdown.
import { $createParagraphNode, $createTextNode, $getRoot } from "lexical";
import { describe, expect, it } from "vitest";

import { $importMarkdownFragment } from "../importMarkdownFragment";
import { exportMarkdown } from "../exportMarkdown";
import { insertFragment, newEditor } from "./harness";

describe("$importMarkdownFragment", () => {
  it("imports a single plain paragraph", () => {
    const { topLevelTypes, exported } = insertFragment("Hello world\n");
    expect(topLevelTypes).toEqual(["paragraph"]);
    expect(exported).toBe("Hello world\n");
  });

  it("imports a multi-paragraph body", () => {
    const markdown = "First paragraph.\n\nSecond, with **bold** text.\n";
    const { topLevelTypes, exported } = insertFragment(markdown);
    expect(topLevelTypes).toEqual(["paragraph", "paragraph"]);
    expect(exported).toBe(markdown);
  });

  it("imports a heading + list body", () => {
    const markdown = "# Checklist\n\n- one\n- two\n";
    const { topLevelTypes, exported } = insertFragment(markdown);
    expect(topLevelTypes).toEqual(["heading", "list"]);
    expect(exported).toBe(markdown);
  });

  it("imports a top-level fence that passes the byte-exact gate as a code block", () => {
    const markdown = "```js\nconsole.log(1);\n```\n";
    const { topLevelTypes, exported } = insertFragment(markdown);
    expect(topLevelTypes).toEqual(["code-block"]);
    expect(exported).toBe(markdown);
  });

  it("falls an exotic construct (HTML block) back to a verbatim unknown block", () => {
    // Raw HTML has no visitor — `canImport` rejects it — so the fragment path
    // must take the same byte-preserving UnknownBlockNode fallback as the
    // whole-document importer.
    const markdown = "<div>\n  <p>raw</p>\n</div>\n";
    const { topLevelTypes, exported } = insertFragment(markdown);
    expect(topLevelTypes).toEqual(["unknown-block"]);
    expect(exported).toBe(markdown);
  });

  it("mixes editable and opaque blocks in one body (paragraph + table)", () => {
    // GFM tables parse to a `table` node with no visitor: the paragraph stays
    // editable while the table becomes an opaque block, sliced byte-for-byte.
    const markdown = "Intro line.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
    const { topLevelTypes, exported } = insertFragment(markdown);
    expect(topLevelTypes).toEqual(["paragraph", "unknown-block"]);
    expect(exported).toBe(markdown);
  });

  it("returns [] for empty and whitespace-only input", () => {
    for (const input of ["", "   ", "\n\n", " \n \t \n"]) {
      const editor = newEditor((error) => {
        throw error;
      });
      editor.update(
        () => {
          expect($importMarkdownFragment(input)).toEqual([]);
        },
        { discrete: true },
      );
    }
  });

  it("does not touch existing root content", () => {
    const editor = newEditor((error) => {
      throw error;
    });
    editor.update(
      () => {
        const existing = $createParagraphNode();
        existing.append($createTextNode("Already here."));
        $getRoot().append(existing);
      },
      { discrete: true },
    );
    editor.update(
      () => {
        // Unlike importMarkdown, the fragment importer must not clear the root:
        // appending its nodes leaves prior content in place.
        for (const node of $importMarkdownFragment("Inserted.\n")) {
          $getRoot().append(node);
        }
      },
      { discrete: true },
    );
    let exported = "";
    editor.getEditorState().read(() => {
      exported = exportMarkdown();
    });
    expect(exported).toBe("Already here.\n\nInserted.\n");
  });
});
