// Clipboard-image paste → upload → inline ImageNode. Active only when the host
// surface supplies an `imageUploadHandler`; without one the plugin registers
// nothing (plain text/markdown paste is left entirely to RichTextPlugin).
//
// The interesting seam is who owns an all-image paste. The host surface
// (NotesView) captures file pastes at the pane level, but deliberately steps
// aside for all-image pastes while in formatted mode (see NotesView.tsx ~1023) —
// the editor is expected to own that case. So we register `PASTE_COMMAND` at
// HIGH priority to win over RichTextPlugin's default paste, claim the event when
// every clipboard file is an image, and upload + insert. Any other paste (text,
// mixed files, a paste with no files) returns false and flows through untouched.
//
// The core (`isImagePaste` + `insertUploadedImages`) is exported as plain
// functions — jsdom's ClipboardEvent-with-files simulation is unreliable, so the
// tests drive these directly with fake File objects and a fake handler, the same
// pattern as SlashMenuPlugin's `applySlashCommand`.
import { useEffect } from "react";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $insertNodes,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
} from "lexical";

import { $createImageNode } from "./nodes/ImageNode";

/**
 * True when a paste is one this plugin should claim: at least one file, and
 * EVERY file is an image. A mixed paste (an image plus a non-image file) returns
 * false so it flows to the default handler untouched — we never want to swallow
 * half of a paste.
 */
export function isImagePaste(files: File[]): boolean {
  return files.length > 0 && files.every((f) => f.type.startsWith("image/"));
}

/**
 * Upload each file and insert an inline ImageNode at the current selection. The
 * uploaded path becomes the image `src` (the markdown the bridge emits), with an
 * empty alt and no title. A single failed upload is logged and skipped, never
 * fatal — the rest still land. Sequential so multiple images keep their order
 * and each insert appends after the previous one's caret.
 */
export async function insertUploadedImages(
  editor: LexicalEditor,
  files: File[],
  uploadHandler: (file: File) => Promise<string>,
): Promise<void> {
  for (const file of files) {
    let src: string;
    try {
      src = await uploadHandler(file);
    } catch (err) {
      console.error("[PasteImagePlugin] image upload failed", err);
      continue;
    }
    editor.update(() => {
      $insertNodes([$createImageNode(src, "", null)]);
    });
  }
}

export function PasteImagePlugin({
  imageUploadHandler,
}: {
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!imageUploadHandler) return;
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!isImagePaste(files)) return false;
        // Claim it: stop RichTextPlugin's default paste, then upload async. The
        // upload handler drives the surface's "uploading…" indicator itself, so
        // there's no extra UI to render here.
        event.preventDefault();
        void insertUploadedImages(editor, files, imageUploadHandler);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, imageUploadHandler]);

  return null;
}
