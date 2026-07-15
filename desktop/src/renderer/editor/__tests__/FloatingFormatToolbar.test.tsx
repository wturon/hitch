// @vitest-environment jsdom
//
// FloatingFormatToolbarPlugin behavior. Like the LinkPopover test, the toolbar is
// selection-driven (registerUpdateListener + $getSelection), so we drive it by
// moving the Lexical selection inside editor.update(...) and flushing with `await
// act` — the deterministic path the plugin reads. jsdom returns a zero DOM-
// selection rect, so the card renders hidden (no coordinates); we assert on
// presence and on the markdown the buttons produce, not on pixel positions.
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalEditor,
} from "lexical";

import { MarkdownEditor } from "../MarkdownEditor";
import { exportMarkdown } from "../bridge";

afterEach(cleanup);

function getEditor(): LexicalEditor {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error("no contenteditable rendered");
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor })
    .__lexicalEditor;
  if (!editor) throw new Error("editor not attached to root element");
  return editor;
}

const toolbar = () =>
  document.querySelector('[aria-label="Text formatting"]');
const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

// Press a toolbar button the way a real click arrives: mousedown first (the
// handler preventDefaults it to keep the editor focused + selection alive), then
// click. Firing click alone drops editor focus and collapses the selection.
async function press(label: string) {
  const el = button(label)!;
  await act(async () => {
    fireEvent.mouseDown(el);
    fireEvent.click(el);
  });
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

async function collapseCaret(editor: LexicalEditor) {
  await act(async () => {
    editor.update(() => $getRoot().selectStart(), { discrete: true });
  });
  await act(async () => {});
}

function readMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => exportMarkdown()).trim();
}

describe("toolbar shows/hides with the selection", () => {
  it("appears on a non-empty range and hides on collapse", async () => {
    render(<MarkdownEditor value="Hello world" onChange={() => {}} />);
    const editor = getEditor();

    expect(toolbar()).toBeNull();

    await selectFirstParagraph(editor);
    expect(toolbar()).not.toBeNull();

    await collapseCaret(editor);
    expect(toolbar()).toBeNull();
  });
});

describe("format buttons mutate the selected text", () => {
  it("bold wraps the selection in **…**", async () => {
    render(<MarkdownEditor value="Hello world" onChange={() => {}} />);
    const editor = getEditor();
    await selectFirstParagraph(editor);

    await press("Bold");
    expect(readMarkdown(editor)).toBe("**Hello world**");
  });

  it("stacks italic + strikethrough on the same selection", async () => {
    render(<MarkdownEditor value="Hello world" onChange={() => {}} />);
    const editor = getEditor();

    // One selection, two buttons — mousedown-preventDefault keeps the range alive
    // between clicks, so the toolbar stays open and formats compose.
    await selectFirstParagraph(editor);
    await press("Italic");
    expect(readMarkdown(editor)).toBe("*Hello world*");

    await press("Strikethrough");
    expect(readMarkdown(editor)).toBe("*~~Hello world~~*");
  });

  it("reflects an already-bold selection as pressed", async () => {
    render(<MarkdownEditor value="**Hello world**" onChange={() => {}} />);
    const editor = getEditor();
    await selectFirstParagraph(editor);

    expect(button("Bold")!.getAttribute("aria-pressed")).toBe("true");
    expect(button("Italic")!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("add-link mode", () => {
  it("wraps the selection in a link and closes the toolbar", async () => {
    render(<MarkdownEditor value="Hello world" onChange={() => {}} />);
    const editor = getEditor();
    await selectFirstParagraph(editor);

    await press("Add link");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Link URL"]',
    );
    expect(input).not.toBeNull();

    await act(async () => {
      fireEvent.change(input!, { target: { value: "https://example.com" } });
      fireEvent.keyDown(input!, { key: "Enter" });
    });
    await act(async () => {});

    expect(readMarkdown(editor)).toBe("[Hello world](https://example.com)");
    expect(toolbar()).toBeNull();
  });
});

describe("save-snippet mode", () => {
  const nameInput = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Snippet name"]');

  // Open the form over a full first-paragraph selection: select, press the
  // toolbar button, and hand back the name input.
  async function openSnippetForm(editor: LexicalEditor) {
    await selectFirstParagraph(editor);
    await press("Save as snippet");
    const input = nameInput();
    expect(input).not.toBeNull();
    return input!;
  }

  it("hides the button when no onSaveSnippet is provided", async () => {
    render(<MarkdownEditor value="Hello world" onChange={() => {}} />);
    await selectFirstParagraph(getEditor());

    expect(toolbar()).not.toBeNull();
    expect(button("Save as snippet")).toBeNull();
  });

  it("shows the button when onSaveSnippet is provided", async () => {
    render(
      <MarkdownEditor
        value="Hello world"
        onChange={() => {}}
        onSaveSnippet={async () => {}}
      />,
    );
    await selectFirstParagraph(getEditor());

    expect(button("Save as snippet")).not.toBeNull();
  });

  it("saves the selected text under the typed name and flashes Saved", async () => {
    const onSaveSnippet = vi.fn().mockResolvedValue(undefined);
    render(
      <MarkdownEditor
        value="Hello world"
        onChange={() => {}}
        onSaveSnippet={onSaveSnippet}
      />,
    );
    const input = await openSnippetForm(getEditor());

    await act(async () => {
      fireEvent.change(input, { target: { value: "Greeting" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await act(async () => {});

    expect(onSaveSnippet).toHaveBeenCalledTimes(1);
    expect(onSaveSnippet).toHaveBeenCalledWith("Greeting", "Hello world");
    // Success swaps the form for the brief confirmation flash.
    expect(nameInput()).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe("Saved");
  });

  it("renders the rejection message inline and keeps the input editable", async () => {
    const onSaveSnippet = vi
      .fn()
      .mockRejectedValue(new Error('A snippet named "Greeting" already exists'));
    render(
      <MarkdownEditor
        value="Hello world"
        onChange={() => {}}
        onSaveSnippet={onSaveSnippet}
      />,
    );
    const input = await openSnippetForm(getEditor());

    await act(async () => {
      fireEvent.change(input, { target: { value: "Greeting" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await act(async () => {});

    const form = document.querySelector('[aria-label="Save snippet"]');
    expect(form?.textContent).toContain(
      'A snippet named "Greeting" already exists',
    );
    expect(nameInput()!.disabled).toBe(false);
  });
});
