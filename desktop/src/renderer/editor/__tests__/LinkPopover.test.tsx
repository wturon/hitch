// @vitest-environment jsdom
//
// LinkPopoverPlugin + PasteLinkPlugin behavior. The popover is selection-driven
// (registerUpdateListener + $getSelection), so we drive it by moving the Lexical
// selection inside `editor.update(...)` and flushing with `await act` — the same
// deterministic path the plugin reads, and the reason it doesn't use a DOM
// selectionchange listener (jsdom can't fire those reliably).
//
// The live editor is grabbed off the contenteditable's `__lexicalEditor` (like the
// image/code tests). Paste is exercised through the exported `tryPasteLink` /
// `isSingleUrl` — jsdom's ClipboardEvent-with-data is unreliable, so we drive the
// decision core directly, exactly as ImageNode.test drives `isImagePaste`.
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $nodesOfType,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { LinkNode } from "@lexical/link";

import { MarkdownEditor } from "../MarkdownEditor";
import { exportMarkdown } from "../bridge";
import { isSingleUrl, tryPasteLink } from "../PasteLinkPlugin";

afterEach(cleanup);

function getEditor(): LexicalEditor {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error("no contenteditable rendered");
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor })
    .__lexicalEditor;
  if (!editor) throw new Error("editor not attached to root element");
  return editor;
}

const previewCard = () =>
  document.querySelector('[aria-label="Link preview"]');
const urlInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Link URL"]');

// Place a collapsed caret at the start of the (single) link's content.
async function caretIntoLink(editor: LexicalEditor) {
  await act(async () => {
    editor.update(
      () => {
        $nodesOfType(LinkNode)[0].selectStart();
      },
      { discrete: true },
    );
  });
  await act(async () => {});
}

// Move the caret out of the link, to the document start.
async function caretOutOfLink(editor: LexicalEditor) {
  await act(async () => {
    editor.update(() => $getRoot().selectStart(), { discrete: true });
  });
  await act(async () => {});
}

// Select the entire text of the first block (a bare paragraph in these fixtures).
async function selectFirstParagraph(editor: LexicalEditor) {
  await act(async () => {
    editor.update(
      () => {
        const block = $getRoot().getFirstChild();
        const text = $isElementNode(block) ? block.getFirstChild() : null;
        if ($isTextNode(text)) text.select(0, text.getTextContentSize());
      },
      { discrete: true },
    );
  });
  await act(async () => {});
}

function readMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => exportMarkdown());
}

// ---------------------------------------------------------------------------
// 1. open on caret-in-link, close on caret-out
// ---------------------------------------------------------------------------
describe("popover opens/closes with the selection", () => {
  it("shows the URL when the caret enters a link and hides it when the caret leaves", async () => {
    render(
      <MarkdownEditor value={"see the [site](https://example.com) now\n"} onChange={() => {}} />,
    );
    const editor = getEditor();
    await act(async () => {});
    expect(previewCard()).toBeNull();

    await caretIntoLink(editor);
    const card = previewCard();
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("example.com");

    await caretOutOfLink(editor);
    expect(previewCard()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. edit + save writes the new URL, keeps text, preserves a title
// ---------------------------------------------------------------------------
describe("edit + save", () => {
  it("updates the URL via the input, leaving the link text unchanged", async () => {
    const onChange = vi.fn();
    render(
      <MarkdownEditor value={"go [site](https://old.com) here\n"} onChange={onChange} />,
    );
    const editor = getEditor();
    await act(async () => {});
    await caretIntoLink(editor);

    await act(async () => {
      fireEvent.click(document.querySelector('[aria-label="Edit link"]')!);
    });
    const input = urlInput();
    expect(input).not.toBeNull();
    expect(input!.value).toBe("https://old.com");

    await act(async () => {
      fireEvent.change(input!, { target: { value: "https://new.com" } });
      fireEvent.keyDown(input!, { key: "Enter" });
    });

    const md = readMarkdown(editor);
    expect(md).toContain("[site](https://new.com)");
    expect(md).not.toContain("old.com");
  });

  it("preserves a link's title through an edit", async () => {
    render(
      <MarkdownEditor
        value={'go [site](https://old.com "the title") here\n'}
        onChange={() => {}}
      />,
    );
    const editor = getEditor();
    await act(async () => {});
    // Sanity: the fixture actually round-trips a title.
    expect(readMarkdown(editor)).toContain('"the title"');

    await caretIntoLink(editor);
    await act(async () => {
      fireEvent.click(document.querySelector('[aria-label="Edit link"]')!);
    });
    await act(async () => {
      fireEvent.change(urlInput()!, { target: { value: "https://new.com" } });
      fireEvent.keyDown(urlInput()!, { key: "Enter" });
    });

    const md = readMarkdown(editor);
    expect(md).toContain('[site](https://new.com "the title")');
  });
});

// ---------------------------------------------------------------------------
// 3. remove unwraps the link to plain text
// ---------------------------------------------------------------------------
describe("remove", () => {
  it("turns [text](url) into text, keeping the words", async () => {
    render(
      <MarkdownEditor value={"go [site](https://old.com) here\n"} onChange={() => {}} />,
    );
    const editor = getEditor();
    await act(async () => {});
    await caretIntoLink(editor);

    await act(async () => {
      fireEvent.click(document.querySelector('[aria-label="Remove link"]')!);
    });

    const md = readMarkdown(editor);
    expect(md).not.toContain("](");
    expect(md).toContain("go site here");
    // Popover closed: the selection is no longer in a link.
    expect(previewCard()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4-6. paste-to-link claim conditions
// ---------------------------------------------------------------------------
describe("paste-to-link", () => {
  it("wraps a selection when a single URL is pasted over it", async () => {
    render(<MarkdownEditor value={"pick me\n"} onChange={() => {}} />);
    const editor = getEditor();
    await act(async () => {});
    await selectFirstParagraph(editor);

    let claimed = false;
    await act(async () => {
      claimed = tryPasteLink(editor, "https://dest.com");
    });
    expect(claimed).toBe(true);
    expect(readMarkdown(editor)).toContain("[pick me](https://dest.com)");
  });

  it("inserts a self-labeled autolink at a collapsed caret, caret landing after it", async () => {
    render(<MarkdownEditor value={"hello\n"} onChange={() => {}} />);
    const editor = getEditor();
    await act(async () => {});
    // Collapsed caret at the end.
    await act(async () => {
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
    });

    let claimed = false;
    await act(async () => {
      claimed = tryPasteLink(editor, "https://dest.com");
    });
    expect(claimed).toBe(true);
    expect(readMarkdown(editor)).toContain("hello<https://dest.com>");

    // The caret must sit AFTER the link: typing now must not extend it.
    await act(async () => {
      editor.update(
        () => {
          const sel = $getSelection();
          if ($isRangeSelection(sel)) sel.insertText("x");
        },
        { discrete: true },
      );
    });
    expect(readMarkdown(editor)).toContain("hello<https://dest.com>x");
  });

  it("does NOT claim a collapsed paste inside an existing link (no nested links)", async () => {
    render(
      <MarkdownEditor value={"go [site](https://old.com) here\n"} onChange={() => {}} />,
    );
    const editor = getEditor();
    await act(async () => {});
    await caretIntoLink(editor);

    let claimed = true;
    await act(async () => {
      claimed = tryPasteLink(editor, "https://dest.com");
    });
    expect(claimed).toBe(false);
    expect(readMarkdown(editor)).toContain("[site](https://old.com)");
  });

  it("does NOT wrap when the pasted text is not a single URL", async () => {
    render(<MarkdownEditor value={"pick me\n"} onChange={() => {}} />);
    const editor = getEditor();
    await act(async () => {});
    await selectFirstParagraph(editor);

    let claimed = true;
    await act(async () => {
      claimed = tryPasteLink(editor, "just some pasted words");
    });
    expect(claimed).toBe(false);
    expect(readMarkdown(editor)).not.toContain("](");
  });

  it("isSingleUrl accepts one http(s) URL and rejects text/whitespace/multiline", () => {
    expect(isSingleUrl("https://a.com/x?y=1")).toBe(true);
    expect(isSingleUrl("  http://a.com  ")).toBe(true);
    expect(isSingleUrl("not a url")).toBe(false);
    expect(isSingleUrl("https://a.com and more")).toBe(false);
    expect(isSingleUrl("https://a.com\nhttps://b.com")).toBe(false);
    expect(isSingleUrl("ftp://a.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Escape closes
// ---------------------------------------------------------------------------
describe("Escape", () => {
  it("closes the preview popover", async () => {
    render(
      <MarkdownEditor value={"go [site](https://example.com) here\n"} onChange={() => {}} />,
    );
    const editor = getEditor();
    await act(async () => {});
    await caretIntoLink(editor);
    expect(previewCard()).not.toBeNull();

    await act(async () => {
      editor.dispatchCommand(
        KEY_ESCAPE_COMMAND,
        new KeyboardEvent("keydown", { key: "Escape" }),
      );
    });
    expect(previewCard()).toBeNull();
  });

  it("stops the Escape that closed the popover from reaching window listeners", async () => {
    // NotesView exits the note on a window-level Escape keydown. The Esc that
    // dismisses the popover is spent — it must not ALSO exit the note. A second
    // Esc (popover closed) must still bubble through.
    render(
      <MarkdownEditor value={"go [site](https://example.com) here\n"} onChange={() => {}} />,
    );
    const editor = getEditor();
    await act(async () => {});
    await caretIntoLink(editor);
    expect(previewCard()).not.toBeNull();

    const windowEsc = vi.fn();
    window.addEventListener("keydown", windowEsc);
    try {
      const root = document.querySelector('[contenteditable="true"]')!;
      await act(async () => {
        fireEvent.keyDown(root, { key: "Escape" });
      });
      expect(previewCard()).toBeNull();
      expect(windowEsc).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.keyDown(root, { key: "Escape" });
      });
      expect(windowEsc).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", windowEsc);
    }
  });
});
