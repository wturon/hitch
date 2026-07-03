// @vitest-environment jsdom
//
// Controlled-contract tests for the production MarkdownEditor (invariants A–E
// from the Text Editor 2.0 spec) plus the focus handle. These need a DOM, so the
// file opts into jsdom via the pragma above; the headless bridge suite stays on
// the node environment (see vitest.config.ts).
//
// Edits are simulated by driving `editor.update(...)` on the live editor instance
// rather than synthesizing keystrokes — deterministic, and it exercises the exact
// path a real keystroke's reconcile takes through the change listener. The editor
// instance is grabbed from the contenteditable DOM node (Lexical stamps
// `__lexicalEditor` on its root element), which lets the tests observe the REAL
// component rather than a re-implementation.
//
// Every interaction is wrapped in `await act(async …)`: Lexical commits a
// non-discrete update on a microtask, and the ControlledMarkdownPlugin's adoption
// runs from a React effect, so the async flush is what lets us read a settled
// state. Test-authored edits also pass `{ discrete: true }` to commit inline.
import { useState, type Dispatch, type SetStateAction } from "react";
import { render, act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  type LexicalEditor,
} from "lexical";

import { MarkdownEditor, type MarkdownEditorHandle } from "../MarkdownEditor";
import { ControlledMarkdownPlugin } from "../ControlledMarkdownPlugin";
import { EDITOR_NODES } from "../config";
import { exportMarkdown, importMarkdown } from "../bridge";
// Namespace import so a test can spy on `importMarkdown` (the plugin imports the
// same live binding from this module) to force the adoption-import failure path.
import * as bridge from "../bridge";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Full-component harness: renders the real MarkdownEditor from React state, with
// an escape hatch (`setValue`) to push a `value` in WITHOUT going through
// onChange — i.e. to simulate an external write, distinct from an echo.
// ---------------------------------------------------------------------------
interface HarnessHandles {
  onChange: ReturnType<typeof vi.fn>;
  /** Push a new `value` prop from outside (an external write). */
  setValue: (v: string) => Promise<void>;
  editorRef: { current: MarkdownEditorHandle | null };
}

function renderEditor(initialValue: string): HarnessHandles {
  const onChange = vi.fn();
  const controlRef: { setValue?: Dispatch<SetStateAction<string>> } = {};
  const editorRef: { current: MarkdownEditorHandle | null } = { current: null };

  function Harness() {
    const [value, setValue] = useState(initialValue);
    controlRef.setValue = setValue;
    return (
      <MarkdownEditor
        ref={editorRef}
        value={value}
        onChange={(md) => {
          onChange(md);
          // Mirror a real parent: adopt our own edit back into state.
          setValue(md);
        }}
      />
    );
  }

  render(<Harness />);
  return {
    onChange,
    setValue: async (v) => {
      await act(async () => {
        controlRef.setValue!(v);
      });
    },
    editorRef,
  };
}

function getEditor(): LexicalEditor {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error("no contenteditable rendered");
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor }).__lexicalEditor;
  if (!editor) throw new Error("editor not attached to root element");
  return editor;
}

function currentMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => exportMarkdown());
}

function firstChildKey(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getFirstChild()!.getKey());
}

// Simulate a user edit by appending text to the first block IN PLACE — so the
// block's node key survives unless something re-imports (which clears the root
// and rebuilds it with fresh keys). That key stability is how the tests prove an
// echo did NOT re-import.
async function appendText(editor: LexicalEditor, text: string) {
  // Settle any pending programmatic commit (the initial-content reconcile that
  // lands once the contenteditable mounts, or a just-triggered adoption) FIRST,
  // so the discrete edit below doesn't flush merged with it and inherit its
  // `history-merge` tag. In production a keystroke can't race the mount commit;
  // this only matters for the test's tight timing.
  await act(async () => {});
  await act(async () => {
    editor.update(
      () => {
        const block = $getRoot().getFirstChild();
        if ($isElementNode(block)) block.append($createTextNode(text));
      },
      { discrete: true },
    );
  });
}

describe("MarkdownEditor — invariant A: opening never dirties", () => {
  it("does not fire onChange when mounted with canonical markdown", () => {
    const { onChange } = renderEditor("# Title\n\nA paragraph.\n");
    expect(onChange).not.toHaveBeenCalled();
    // Content actually imported.
    expect(currentMarkdown(getEditor())).toBe("# Title\n\nA paragraph.\n");
  });

  it("does not fire onChange when mounted with NON-canonical markdown", () => {
    // `*` bullets export as `-` bullets — the round-trip is not byte-identical,
    // yet merely opening must stay silent (no dirty from normalization).
    const { onChange } = renderEditor("* one\n* two\n");
    expect(onChange).not.toHaveBeenCalled();
    // It imported the list and would re-serialize canonically if asked.
    expect(currentMarkdown(getEditor())).toBe("- one\n- two\n");
  });
});

describe("MarkdownEditor — invariant B: typing emits, echo is inert", () => {
  it("emits exactly one onChange with the expected markdown, and echoing it back does not re-import", async () => {
    const { onChange } = renderEditor("start\n");
    const editor = getEditor();
    const keyBefore = firstChildKey(editor);

    await appendText(editor, "X"); // in-place edit → "startX"

    // Exactly one emission, carrying the freshly exported markdown.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("startX\n");

    // The Harness echoed that value back through `value`. The block key is
    // unchanged → no re-import happened (a re-import clears the root and mints a
    // new key), so caret and history survive.
    expect(firstChildKey(editor)).toBe(keyBefore);
    // Still exactly one — the echo did not produce a second emission.
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("MarkdownEditor — invariant C: external values adopt silently", () => {
  it("re-imports an external value without firing onChange", async () => {
    const { onChange, setValue } = renderEditor("# One\n");
    const editor = getEditor();
    const keyBefore = firstChildKey(editor);

    // A genuine external write (non-canonical `*` bullets), pushed straight
    // through `value` — not via onChange.
    await setValue("* a\n* b\n");

    expect(onChange).not.toHaveBeenCalled(); // adoption is silent
    expect(firstChildKey(editor)).not.toBe(keyBefore); // it re-imported
    expect(currentMarkdown(editor)).toBe("- a\n- b\n"); // canonical re-export
  });
});

describe("MarkdownEditor — invariant D: editing continues cleanly after adoption", () => {
  it("emits normally after a non-canonical adoption, and that emission echoes inert (no loop)", async () => {
    const { onChange, setValue } = renderEditor("# One\n");
    const editor = getEditor();

    // Adopt a non-canonical paragraph (`_hi_` exports as `*hi*`).
    await setValue("_hi_\n");
    expect(onChange).not.toHaveBeenCalled();
    expect(currentMarkdown(editor)).toBe("*hi*\n");

    const keyAfterAdopt = firstChildKey(editor);

    // The next keystroke exports canonical markdown and emits once. This is the
    // non-canonical-adoption trap: the export ("*hi*Z") won't match the adopted
    // raw string ("_hi_"), but the refs must not treat that as a reason to
    // re-import or emit twice.
    await appendText(editor, "Z");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("*hi*Z\n");
    // The edit was in-place and its echo was inert → block key survived.
    expect(firstChildKey(editor)).toBe(keyAfterAdopt);
  });
});

describe("MarkdownEditor — external reverts to previously-seen bytes still adopt", () => {
  // Regression tests for the stale-ref bug: with separate last-emitted /
  // last-adopted refs, a genuine external write whose bytes exactly matched an
  // OLDER state (a `git checkout`-style revert of the file) was silently dropped
  // — leaving the editor and the file diverged, and the next keystroke would
  // clobber the external write. A single "value the editor currently reflects"
  // ref has no stale bytes to wrongly match.

  it("adopts a revert to a prior adoption's exact bytes after an intervening edit", async () => {
    const { onChange, setValue } = renderEditor("# One\n");
    const editor = getEditor();

    await setValue("_hi_\n"); // adopt non-canonical bytes
    await appendText(editor, "Z"); // user edits → emits "*hi*Z\n"
    expect(onChange).toHaveBeenLastCalledWith("*hi*Z\n");
    onChange.mockClear();

    // An agent reverts the file to the EXACT bytes adopted earlier. This must
    // re-import (the editor no longer reflects them), silently.
    await setValue("_hi_\n");
    expect(onChange).not.toHaveBeenCalled();
    expect(currentMarkdown(editor)).toBe("*hi*\n"); // canonical form of the revert
  });

  it("adopts a revert to the initial value after an intervening adoption", async () => {
    const { onChange, setValue } = renderEditor("initial\n");
    const editor = getEditor();

    await setValue("hello\n"); // external write
    expect(currentMarkdown(editor)).toBe("hello\n");

    // External revert back to the exact initial bytes — must re-import, not be
    // mistaken for an echo of the (long-gone) mount value.
    await setValue("initial\n");
    expect(onChange).not.toHaveBeenCalled();
    expect(currentMarkdown(editor)).toBe("initial\n");
  });
});

describe("MarkdownEditor — invariant E: failures don't crash the surface", () => {
  it("swallows and logs an export failure, skipping that emission", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { onChange } = renderEditor("start\n");
    const editor = getEditor();

    // Insert a node the bridge can't serialize: an underline-formatted text node
    // (bit 8 is outside the bridge's supported set), so exportMarkdown throws.
    await act(async () => {}); // settle the initial commit first (see appendText)
    await act(async () => {
      editor.update(
        () => {
          const block = $getRoot().getFirstChild();
          if ($isElementNode(block)) block.append($createTextNode("u").setFormat(8));
        },
        { discrete: true },
      );
    });

    expect(consoleError).toHaveBeenCalled(); // logged
    expect(onChange).not.toHaveBeenCalled(); // emission skipped, not crashed
    // The editor tree is still mounted and usable.
    expect(document.querySelector('[contenteditable="true"]')).not.toBeNull();

    consoleError.mockRestore();
  });

  it("swallows and logs an import failure on adoption, keeping the current document", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const importSpy = vi.spyOn(bridge, "importMarkdown");
    const { onChange, setValue } = renderEditor("# Keep me\n");
    const editor = getEditor();
    const before = currentMarkdown(editor);

    // Force the adoption import to throw.
    importSpy.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await setValue("something new\n");

    expect(consoleError).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    // Document unchanged — the failed import did not blow away the tree.
    expect(currentMarkdown(editor)).toBe(before);

    importSpy.mockRestore();
    consoleError.mockRestore();
  });
});

describe("MarkdownEditor — focus handle", () => {
  it("focusStart / focusEnd place the selection at the document start / end", async () => {
    const { editorRef } = renderEditor("# Heading\n\nlast line\n");
    const editor = getEditor();

    await act(async () => editorRef.current!.focusStart());
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      expect($isRangeSelection(sel)).toBe(true);
      if (!$isRangeSelection(sel)) return;
      expect(sel.isCollapsed()).toBe(true);
      // First leaf is the heading's text.
      expect(sel.anchor.getNode().getTextContent()).toBe("Heading");
      expect(sel.anchor.offset).toBe(0);
    });

    await act(async () => editorRef.current!.focusEnd());
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      expect($isRangeSelection(sel)).toBe(true);
      if (!$isRangeSelection(sel)) return;
      expect(sel.isCollapsed()).toBe(true);
      // Last leaf is the final paragraph's text, caret at its end.
      expect(sel.anchor.getNode().getTextContent()).toBe("last line");
      expect(sel.anchor.offset).toBe("last line".length);
    });
  });
});

// ---------------------------------------------------------------------------
// The controlled logic in isolation: ControlledMarkdownPlugin inside a minimal
// composer we fully control (no MarkdownEditor chrome), proving it's testable on
// its own. A tiny capture plugin hands the editor to the test.
// ---------------------------------------------------------------------------
describe("ControlledMarkdownPlugin — minimal composer", () => {
  function CapturePlugin({ onReady }: { onReady: (e: LexicalEditor) => void }) {
    const [editor] = useLexicalComposerContext();
    onReady(editor);
    return null;
  }

  it("adopts an external value silently and leaves later edits emitting", async () => {
    const onChange = vi.fn();
    let editor!: LexicalEditor;
    let setValue!: Dispatch<SetStateAction<string>>;

    const config = {
      namespace: "test",
      nodes: [...EDITOR_NODES],
      editorState: () => importMarkdown("initial\n"),
      onError: (e: Error) => {
        throw e;
      },
    };

    function Minimal() {
      const [value, setVal] = useState("initial\n");
      setValue = setVal;
      return (
        <LexicalComposer initialConfig={config}>
          <CapturePlugin onReady={(e) => (editor = e)} />
          <ControlledMarkdownPlugin
            value={value}
            onChange={(md) => {
              onChange(md);
              setVal(md);
            }}
          />
        </LexicalComposer>
      );
    }

    render(<Minimal />);
    expect(onChange).not.toHaveBeenCalled(); // mount is silent

    await act(async () => setValue("adopted\n")); // external adoption
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.getEditorState().read(() => exportMarkdown())).toBe("adopted\n");

    await act(async () => {
      editor.update(
        () => {
          const block = $getRoot().getFirstChild();
          if ($isElementNode(block)) block.append($createTextNode("!"));
        },
        { discrete: true },
      );
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("adopted!\n");
  });
});
