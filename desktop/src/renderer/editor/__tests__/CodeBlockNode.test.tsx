// @vitest-environment jsdom
//
// Code block tests. Two layers, mirroring the Image + SlashMenu suites:
//
//   - Component (real MarkdownEditor): typing in the decorator's <textarea>
//     fires exactly the controlled onChange with the updated fence, and a
//     node-selected block deletes on Backspace.
//   - Actions on a headless editor: the ``` typing shortcut (via the transformer's
//     own regExp + replace, the exact path MarkdownShortcutPlugin runs) converts a
//     paragraph into a code block, and the slash-menu "Code block" entry inserts
//     one followed by a guaranteed trailing paragraph.
//
// The base-ui <Select> language dropdown is a portalled, pointer-driven popup
// jsdom can't faithfully open, so the language→fence wiring is asserted through
// the live editor's node (setLanguage) here and byte-for-byte in the bridge
// suite; the visual dropdown is covered by the e2e harness.
import { render, act, cleanup } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeadlessEditor } from "@lexical/headless";
import { registerList } from "@lexical/list";
import {
  $createParagraphNode,
  $createTextNode,
  $createNodeSelection,
  $getRoot,
  $nodesOfType,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
} from "lexical";

import { MarkdownEditor } from "../MarkdownEditor";
import { exportMarkdown } from "../bridge";
import { CODE_BLOCK_TRANSFORMER, EDITOR_NODES } from "../config";
import { CodeBlockNode, $isCodeBlockNode } from "../nodes/CodeBlockNode";
import { SLASH_COMMANDS, applySlashCommand } from "../SlashMenuPlugin";
import * as highlight from "../highlight";

// Mock the Shiki highlighter: the real one loads asynchronously via dynamic
// import(), too slow/flaky for the unit suite. This stub starts "not loaded"
// (highlightToHtml → null → plain fallback), and a test-only `__setReady()`
// flips it to "loaded" and notifies subscribers, so we can assert the plain →
// highlighted transition and that the textarea value stays authoritative. The
// emitted markup mirrors Shiki's shape (`<pre class="shiki">…<span>`).
vi.mock("../highlight", () => {
  let ready = false;
  const listeners = new Set<() => void>();
  return {
    getHighlighter: () => (ready ? {} : null),
    onHighlighterReady: (fn: () => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    highlightToHtml: (code: string, language: string) =>
      ready && language === "ts"
        ? `<pre class="shiki"><code><span class="line"><span class="tok">${code
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")}</span></span></code></pre>`
        : null,
    shikiLang: (l: string) => (l === "ts" ? "typescript" : null),
    LIGHT_THEME: "github-light",
    DARK_THEME: "github-dark",
    __resetHighlighterForTests: () => {
      ready = false;
      listeners.clear();
    },
    __setReady: () => {
      ready = true;
      for (const fn of listeners) fn();
    },
  };
});

const setHighlighterReady = () =>
  (highlight as unknown as { __setReady: () => void }).__setReady();

afterEach(() => {
  cleanup();
  highlight.__resetHighlighterForTests();
});

function getEditor(): LexicalEditor {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error("no contenteditable rendered");
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor })
    .__lexicalEditor;
  if (!editor) throw new Error("editor not attached to root element");
  return editor;
}

function codeTextarea(): HTMLTextAreaElement {
  const ta = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Code block"]',
  );
  if (!ta) throw new Error("no code block textarea rendered");
  return ta;
}

function newHeadless(): LexicalEditor {
  const editor = createHeadlessEditor({
    namespace: "code-block-test",
    nodes: [...EDITOR_NODES],
    onError: (error) => {
      throw error;
    },
  });
  registerList(editor);
  return editor;
}

// ---------------------------------------------------------------------------
// Component: the decorator textarea
// ---------------------------------------------------------------------------
describe("code block textarea drives onChange", () => {
  it("typing emits one onChange with the updated fence", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"```ts\nold();\n```\n"} onChange={onChange} />);
    await act(async () => {});
    onChange.mockClear();

    await act(async () => {
      fireEvent.change(codeTextarea(), { target: { value: "fresh();" } });
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe("```ts\nfresh();\n```\n");
  });

  it("changing the language (node path) re-emits with the new fence lang", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"```ts\nx();\n```\n"} onChange={onChange} />);
    const editor = getEditor();
    await act(async () => {});
    onChange.mockClear();

    await act(async () => {
      editor.update(
        () => {
          const node = $nodesOfType(CodeBlockNode)[0];
          if ($isCodeBlockNode(node)) node.setLanguage("bash");
        },
        { discrete: true },
      );
    });

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)![0]).toBe("```bash\nx();\n```\n");
  });
});

describe("code block keyboard: Tab and undo routing", () => {
  it("Tab inserts two spaces at the caret and syncs the node (never tabs focus out)", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"```ts\nab\n```\n"} onChange={onChange} />);
    await act(async () => {});
    onChange.mockClear();

    const ta = codeTextarea();
    ta.setSelectionRange(1, 1); // between "a" and "b"
    let prevented = false;
    await act(async () => {
      prevented = !fireEvent.keyDown(ta, { key: "Tab" });
    });

    expect(prevented).toBe(true); // default (focus move) suppressed
    expect(ta.value).toBe("a  b");
    expect(ta.selectionStart).toBe(3); // caret after the inserted spaces
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe("```ts\na  b\n```\n");
  });

  it("⌘Z routes to Lexical history (native default suppressed) and reverts the edit", async () => {
    // Fake only Date: HistoryPlugin coalesces updates landing within its delay
    // window into one entry, and a test runs entirely inside that window — step
    // the clock so the edit is its own undoable entry, as it is in real typing.
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now();
    const onChange = vi.fn();
    render(<MarkdownEditor value={"```ts\nold();\n```\n"} onChange={onChange} />);
    await act(async () => {});

    // Two edits: in this jsdom mount order the initial reconcile lands before
    // HistoryPlugin registers, so the first edit only seeds history's `current`
    // (nothing on the undo stack yet) — the second edit is the undoable one.
    vi.setSystemTime(base + 1000);
    await act(async () => {
      fireEvent.change(codeTextarea(), { target: { value: "mid();" } });
    });
    vi.setSystemTime(base + 2000);
    await act(async () => {
      fireEvent.change(codeTextarea(), { target: { value: "fresh();" } });
    });
    expect(codeTextarea().value).toBe("fresh();");
    onChange.mockClear();
    vi.setSystemTime(base + 3000);

    let prevented = false;
    await act(async () => {
      prevented = !fireEvent.keyDown(codeTextarea(), {
        key: "z",
        metaKey: true,
      });
    });

    expect(prevented).toBe(true); // the textarea's own undo stack never runs
    // Lexical history reverted the setCode commit; the adoption sync brought the
    // textarea along, and the revert emitted through the controlled contract.
    expect(codeTextarea().value).toBe("mid();");
    expect(onChange.mock.calls.at(-1)![0]).toBe("```ts\nmid();\n```\n");
    vi.useRealTimers();
  });
});

describe("modifier-key containment (inverted allowlist contract)", () => {
  // jsdom can't emulate the NATIVE textarea edits ⌘⌫/⌥⌫ perform, so we test the
  // CONTRACT the fix guarantees: those keys are (a) never default-prevented (so
  // the browser's own delete-to-line-start / delete-word runs) and (b) never
  // bubble to a listener on Lexical's contentEditable root — where Lexical maps
  // ⌘⌫/⌥⌫ to DELETE_LINE/DELETE_WORD, preventDefaults, and mutates its own stale
  // selection. Only the app-global allowlist (⌘K) is allowed to reach the root.
  async function setup() {
    render(
      <MarkdownEditor value={"```ts\nhello world\n```\n"} onChange={() => {}} />,
    );
    await act(async () => {});
    const root = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    let rootSaw = false;
    root.addEventListener("keydown", () => {
      rootSaw = true;
    });
    const ta = codeTextarea();
    ta.focus();
    ta.setSelectionRange(11, 11); // end of "hello world"
    return { ta, seen: () => rootSaw, reset: () => (rootSaw = false) };
  }

  it("⌘⌫ is contained and not default-prevented (native delete-to-line-start runs)", async () => {
    const { ta, seen } = await setup();
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(ta, { key: "Backspace", metaKey: true });
    });
    expect(notPrevented).toBe(true); // default NOT prevented → native edit runs
    expect(seen()).toBe(false); // never reached Lexical's root
  });

  it("⌥⌫ is contained and not default-prevented (native delete-word runs)", async () => {
    const { ta, seen } = await setup();
    let notPrevented = true;
    await act(async () => {
      notPrevented = fireEvent.keyDown(ta, { key: "Backspace", altKey: true });
    });
    expect(notPrevented).toBe(true);
    expect(seen()).toBe(false);
  });

  it("⌘K (allowlisted app-global) DOES reach the root; a plain char does not", async () => {
    const { ta, seen, reset } = await setup();
    await act(async () => {
      fireEvent.keyDown(ta, { key: "k", metaKey: true });
    });
    expect(seen()).toBe(true); // ⌘K bubbles out to open the command palette

    reset();
    await act(async () => {
      fireEvent.keyDown(ta, { key: "a" });
    });
    expect(seen()).toBe(false); // plain typing stays inside the block
  });
});

describe("Enter auto-indents from the current line", () => {
  it("carries the leading whitespace of an indented line onto the new line", async () => {
    const onChange = vi.fn();
    render(
      <MarkdownEditor value={"```ts\n    indented\n```\n"} onChange={onChange} />,
    );
    await act(async () => {});
    onChange.mockClear();

    const ta = codeTextarea();
    ta.setSelectionRange(12, 12); // end of "    indented" (4 spaces + 8 chars)
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });

    expect(ta.value).toBe("    indented\n    "); // new line inherits the 4 spaces
    expect(ta.selectionStart).toBe(17); // caret after the carried indent
    expect(onChange.mock.calls.at(-1)![0]).toBe("```ts\n    indented\n    \n```\n");
  });

  it("inserts a plain newline (no indent) from an unindented line", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"```ts\nflush\n```\n"} onChange={onChange} />);
    await act(async () => {});
    onChange.mockClear();

    const ta = codeTextarea();
    ta.setSelectionRange(5, 5); // end of "flush"
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });

    expect(ta.value).toBe("flush\n");
    expect(ta.selectionStart).toBe(6);
  });
});

describe("Shiki highlight overlay", () => {
  function sizer() {
    return document.querySelector(".hitch-code-overlay");
  }

  it("renders plain fallback before load, then token spans once loaded; textarea stays authoritative", async () => {
    render(<MarkdownEditor value={"```ts\nconst x = 1;\n```\n"} onChange={() => {}} />);
    await act(async () => {});

    // Before the highlighter loads: a plain fallback pre, no Shiki spans.
    expect(sizer()!.querySelector(".hitch-code-fallback")).not.toBeNull();
    expect(sizer()!.querySelector(".shiki")).toBeNull();
    // The textarea already holds the code — editable without the highlighter.
    expect(codeTextarea().value).toBe("const x = 1;");

    // Load the highlighter: the plain fallback swaps to Shiki token spans.
    await act(async () => {
      setHighlighterReady();
    });
    const shiki = sizer()!.querySelector(".shiki");
    expect(shiki).not.toBeNull();
    expect(shiki!.querySelector("span.tok")).not.toBeNull();
    expect(shiki!.textContent).toContain("const x = 1;");
    // The textarea value is still the source of truth (unchanged by highlighting).
    expect(codeTextarea().value).toBe("const x = 1;");
  });

  it("keeps the plain fallback for an unknown language even when loaded", async () => {
    render(
      <MarkdownEditor value={"```unknownlang\nz\n```\n"} onChange={() => {}} />,
    );
    await act(async () => {});
    await act(async () => {
      setHighlighterReady();
    });
    expect(sizer()!.querySelector(".shiki")).toBeNull();
    expect(sizer()!.querySelector(".hitch-code-fallback")).not.toBeNull();
  });
});

describe("Backspace on a node-selected code block removes it", () => {
  it("deletes the block under a NodeSelection", async () => {
    render(<MarkdownEditor value={"```ts\nkeep();\n```\n"} onChange={() => {}} />);
    const editor = getEditor();
    await act(async () => {});
    expect(editor.getEditorState().read(() => $nodesOfType(CodeBlockNode).length)).toBe(1);

    // Node-select the block (what Escape / a click into empty area does), flush so
    // the decorator's delete handler goes live, then Backspace.
    await act(async () => {
      editor.update(
        () => {
          const node = $nodesOfType(CodeBlockNode)[0];
          const sel = $createNodeSelection();
          sel.add(node.getKey());
          $setSelection(sel);
        },
        { discrete: true },
      );
    });
    await act(async () => {});
    await act(async () => {
      editor.dispatchCommand(
        KEY_BACKSPACE_COMMAND,
        new KeyboardEvent("keydown", { key: "Backspace" }),
      );
    });

    expect(editor.getEditorState().read(() => $nodesOfType(CodeBlockNode).length)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Actions on a headless editor
// ---------------------------------------------------------------------------
describe("``` typing shortcut converts a paragraph to a code block", () => {
  it("runs the transformer's regExp + replace on a fence opener", () => {
    const editor = newHeadless();
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        // What the paragraph holds the instant the trigger SPACE is typed.
        paragraph.append($createTextNode("```ts "));
        root.append(paragraph);
        const match = "```ts ".match(CODE_BLOCK_TRANSFORMER.regExp);
        if (!match) throw new Error("fence regExp did not match");
        CODE_BLOCK_TRANSFORMER.replace(paragraph, [], match, false);
      },
      { discrete: true },
    );

    const types: string[] = [];
    editor.getEditorState().read(() => {
      $getRoot()
        .getChildren()
        .forEach((n) => types.push(n.getType()));
    });
    expect(types).toContain("code-block");
    // An empty-bodied ts fence serializes without an interior blank line.
    const md = editor.getEditorState().read(() => exportMarkdown());
    expect(md).toBe("```ts\n```\n");
  });

  it("captures a bare fence as a lang-less code block", () => {
    const editor = newHeadless();
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode("``` "));
        root.append(paragraph);
        const match = "``` ".match(CODE_BLOCK_TRANSFORMER.regExp);
        if (!match) throw new Error("fence regExp did not match");
        CODE_BLOCK_TRANSFORMER.replace(paragraph, [], match, false);
      },
      { discrete: true },
    );
    const md = editor.getEditorState().read(() => exportMarkdown());
    expect(md).toBe("```\n```\n");
  });
});

describe("slash-menu 'Code block' inserts a block + trailing paragraph", () => {
  it("inserts a code block and guarantees a paragraph after it", () => {
    const editor = newHeadless();
    const cmd = SLASH_COMMANDS.find((c) => c.key === "code");
    if (!cmd) throw new Error("no 'code' slash command");

    // Build the block and run the action in one discrete update — the same shape
    // the SlashMenuPlugin action tests use (applySlashCommand opens its own
    // update; a discrete outer commit keeps the read below synchronous).
    editor.update(
      () => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        root.append(paragraph);
        paragraph.selectStart();
        applySlashCommand(editor, cmd, null);
      },
      { discrete: true },
    );

    const types: string[] = [];
    editor.getEditorState().read(() => {
      $getRoot()
        .getChildren()
        .forEach((n) => types.push(n.getType()));
    });
    expect(types).toContain("code-block");
    // A paragraph follows the code block so the caret has somewhere to land.
    const codeIndex = types.indexOf("code-block");
    expect(types[codeIndex + 1]).toBe("paragraph");
  });
});
