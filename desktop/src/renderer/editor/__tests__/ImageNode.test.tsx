// @vitest-environment jsdom
//
// Image support tests: the ImageComponent decorator's Skeleton→img→error states,
// the exported paste handler (driven directly — jsdom's ClipboardEvent-with-files
// is unreliable), the one-onChange-per-insert contract, and Backspace deletion of
// a node-selected image. Follows MarkdownEditor.test.tsx: the live editor is
// grabbed off the contenteditable's `__lexicalEditor`, edits run via
// `editor.update(..., {discrete:true})` inside `await act()`.
import { render, act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  $createNodeSelection,
  $getRoot,
  $nodesOfType,
  $setSelection,
  KEY_BACKSPACE_COMMAND,
  type LexicalEditor,
} from "lexical";

import { MarkdownEditor } from "../MarkdownEditor";
import { exportMarkdown } from "../bridge";
import { ImageNode } from "../nodes/ImageNode";
import { isImagePaste, insertUploadedImages } from "../PasteImagePlugin";

afterEach(cleanup);

function getEditor(): LexicalEditor {
  const el = document.querySelector('[contenteditable="true"]');
  if (!el) throw new Error("no contenteditable rendered");
  const editor = (el as unknown as { __lexicalEditor?: LexicalEditor })
    .__lexicalEditor;
  if (!editor) throw new Error("editor not attached to root element");
  return editor;
}

function countImages(editor: LexicalEditor): number {
  return editor
    .getEditorState()
    .read(() => $nodesOfType(ImageNode).length);
}

// ---------------------------------------------------------------------------
// ImageComponent decorator states
// ---------------------------------------------------------------------------
describe("ImageComponent — Skeleton → img → loaded", () => {
  it("shows the Skeleton while the preview handler is pending, then renders the resolved <img>", async () => {
    let resolvePreview!: (v: string) => void;
    const previewHandler = vi.fn(
      () => new Promise<string>((r) => (resolvePreview = r)),
    );

    render(
      <MarkdownEditor
        value={"![pic](orig.png)\n"}
        onChange={() => {}}
        imagePreviewHandler={previewHandler}
      />,
    );
    // Let the editor commit + the decorator mount + the resolve effect fire.
    await act(async () => {});

    // Preview still pending → Skeleton visible, no <img> yet.
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(previewHandler).toHaveBeenCalledWith("orig.png");

    // Resolve the preview → <img> mounts with the resolved src (still "loading"
    // until it fires load, so the Skeleton stays up).
    await act(async () => {
      resolvePreview("resolved.png");
    });
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("resolved.png");
    expect(document.querySelector('[data-slot="skeleton"]')).not.toBeNull();

    // The image actually loads → Skeleton gone, <img> shown.
    await act(async () => {
      img!.dispatchEvent(new Event("load"));
    });
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(document.querySelector("img")).not.toBeNull();
  });
});

describe("ImageComponent — error state", () => {
  it("shows the bordered placeholder with the raw src when a non-attachments image errors", async () => {
    const previewHandler = vi.fn(async (src: string) => src);
    render(
      <MarkdownEditor
        value={"![pic](broken.png)\n"}
        onChange={() => {}}
        imagePreviewHandler={previewHandler}
      />,
    );
    await act(async () => {});

    const img = document.querySelector("img");
    expect(img).not.toBeNull();

    // A non-attachments src doesn't retry — it settles into the error box.
    await act(async () => {
      img!.dispatchEvent(new Event("error"));
    });

    expect(document.querySelector("img")).toBeNull();
    const placeholder = document.querySelector('[role="img"]');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.textContent).toContain("broken.png");
  });
});

// ---------------------------------------------------------------------------
// Paste handler (exported functions, driven directly)
// ---------------------------------------------------------------------------
describe("isImagePaste", () => {
  const img = (type = "image/png") => new File([new Uint8Array([1])], "x", { type });
  const txt = () => new File(["hi"], "n.txt", { type: "text/plain" });

  it("claims a paste that is all images", () => {
    expect(isImagePaste([img()])).toBe(true);
    expect(isImagePaste([img("image/jpeg"), img()])).toBe(true);
  });

  it("returns false for an empty paste", () => {
    expect(isImagePaste([])).toBe(false);
  });

  it("returns false for a MIXED paste (image + non-image)", () => {
    expect(isImagePaste([img(), txt()])).toBe(false);
  });
});

describe("insertUploadedImages — one onChange with the image markdown", () => {
  it("uploads and inserts an inline image, emitting exactly one onChange", async () => {
    const onChange = vi.fn();
    render(<MarkdownEditor value={"start\n"} onChange={onChange} />);
    const editor = getEditor();
    await act(async () => {});

    // Park a caret at the end so $insertNodes has a range selection.
    await act(async () => {
      editor.update(() => $getRoot().selectEnd(), { discrete: true });
    });
    onChange.mockClear();

    const file = new File([new Uint8Array([1, 2, 3])], "p.png", {
      type: "image/png",
    });
    const upload = vi.fn(async () => "attachments/pasted-image-1.png");

    await act(async () => {
      await insertUploadedImages(editor, [file], upload);
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as string;
    expect(emitted).toContain("![](attachments/pasted-image-1.png)");
    // And the live tree really holds one image node.
    expect(countImages(editor)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Node-selected image deletion
// ---------------------------------------------------------------------------
describe("Backspace on a node-selected image removes it", () => {
  it("deletes the image node under a NodeSelection", async () => {
    render(
      <MarkdownEditor
        value={"before ![a](x.png) after\n"}
        onChange={() => {}}
        imagePreviewHandler={async (s) => s}
      />,
    );
    const editor = getEditor();
    await act(async () => {});
    expect(countImages(editor)).toBe(1);

    // Node-select the image (what a click does), then flush so the decorator's
    // useLexicalNodeSelection sees isSelected=true and its delete handler is live.
    await act(async () => {
      editor.update(
        () => {
          const image = $nodesOfType(ImageNode)[0];
          const sel = $createNodeSelection();
          sel.add(image.getKey());
          $setSelection(sel);
        },
        { discrete: true },
      );
    });
    await act(async () => {});

    // Backspace with the image node-selected removes it.
    await act(async () => {
      editor.dispatchCommand(
        KEY_BACKSPACE_COMMAND,
        new KeyboardEvent("keydown", { key: "Backspace" }),
      );
    });

    expect(countImages(editor)).toBe(0);
    const md = editor.getEditorState().read(() => exportMarkdown());
    expect(md).not.toContain("![a](x.png)");
  });
});
