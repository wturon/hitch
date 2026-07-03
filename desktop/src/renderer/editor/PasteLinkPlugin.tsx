// Paste-over-selection auto-link (the Notion move): select some text, paste a URL,
// and the selection becomes a link instead of being replaced by the URL text.
//
// We register PASTE_COMMAND at HIGH priority so we can claim the paste before
// RichTextPlugin's default (COMMAND_PRIORITY_EDITOR) inserts plain text. We claim
// ONLY when every condition holds:
//   - the clipboard carries NO files — an image paste must keep winning, and its
//     claim condition is files-present, so we step aside whenever files exist;
//   - the pasted text (trimmed) is a single URL: `https?://` + no whitespace, one
//     line (a bare word, a sentence, or multi-line text is left to default paste —
//     we deliberately do NOT auto-linkify arbitrary text);
//   - the selection is a non-collapsed range of actual text content.
// Anything else returns false and flows through untouched.
//
// A collapsed caret + URL paste is intentionally NOT claimed: bare URLs aren't
// links in our markdown flavor, so default paste inserts the plain text.
//
// The DOM paste event dispatches PASTE_COMMAND OUTSIDE any editor.update (unlike
// the slash menu, which runs inside the typeahead's update), so we open our own:
// we read the selection to decide, then mutate in a fresh update — the same shape
// as `@lexical/rich-text`'s own paste handler. The decision + mutation core is
// exported as plain functions so the tests can drive them directly (jsdom's
// ClipboardEvent-with-data is unreliable — the same reason PasteImagePlugin
// exports `isImagePaste`).
import { useEffect } from "react";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { $toggleLink } from "@lexical/link";

// A single, whitespace-free http(s) URL on one line. Trimmed by the caller.
const SINGLE_URL = /^https?:\/\/\S+$/;

export function isSingleUrl(text: string): boolean {
  return SINGLE_URL.test(text.trim());
}

/**
 * Wrap the current selection in a link with `text` when — and only when — `text`
 * is a single URL AND the selection is a non-empty range of text. Returns true if
 * it claimed the paste (caller should then preventDefault), false to let default
 * paste run. Reads the selection first (cheap, no mutation), then wraps in its own
 * update so the read/decide/mutate split stays clean.
 */
export function tryPasteLink(editor: LexicalEditor, text: string): boolean {
  const url = text.trim();
  if (!isSingleUrl(url)) return false;

  let claim = false;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    claim =
      $isRangeSelection(selection) &&
      !selection.isCollapsed() &&
      selection.getTextContent().length > 0;
  });
  if (!claim) return false;

  editor.update(() => {
    // Wraps the selected text in a LinkNode (or, over an existing link, replaces
    // its URL) — serializes to `[text](url)` either way.
    $toggleLink(url);
  });
  return true;
}

export function PasteLinkPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event: ClipboardEvent) => {
        const clipboard = event.clipboardData;
        // No clipboard, or any files present → not ours (image paste owns files).
        if (!clipboard || clipboard.files.length > 0) return false;
        const text = clipboard.getData("text/plain") ?? "";
        if (!tryPasteLink(editor, text)) return false;
        event.preventDefault();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}
