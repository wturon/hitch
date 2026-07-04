// Paste-a-URL auto-link (the Notion move), two flavors:
//   - over a selection: the selected text becomes a link to the pasted URL;
//   - at a collapsed caret: the URL is inserted as a link whose text IS the URL
//     (serializes as a CommonMark autolink `<https://…>`), with the caret placed
//     AFTER the link so continued typing stays unlinked.
//
// We register PASTE_COMMAND at HIGH priority so we can claim the paste before
// RichTextPlugin's default (COMMAND_PRIORITY_EDITOR) inserts plain text. We claim
// ONLY when every condition holds:
//   - the clipboard carries NO files — an image paste must keep winning, and its
//     claim condition is files-present, so we step aside whenever files exist;
//   - the pasted text (trimmed) is a single URL: `https?://` + no whitespace, one
//     line (a bare word, a sentence, or multi-line text is left to default paste —
//     we deliberately do NOT auto-linkify arbitrary text);
//   - a collapsed caret is NOT already inside a link (nested links aren't a
//     thing; default paste applies there).
// Anything else returns false and flows through untouched.
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
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { $createLinkNode, $isLinkNode, $toggleLink } from "@lexical/link";
import { $findMatchingParent } from "@lexical/utils";

// A single, whitespace-free http(s) URL on one line. Trimmed by the caller.
const SINGLE_URL = /^https?:\/\/\S+$/;

export function isSingleUrl(text: string): boolean {
  return SINGLE_URL.test(text.trim());
}

/**
 * Handle a pasted single URL: wrap a non-empty selection in a link, or insert a
 * self-labeled link at a collapsed caret. Returns true if it claimed the paste
 * (caller should then preventDefault), false to let default paste run. Reads the
 * selection first (cheap, no mutation), then mutates in its own update so the
 * read/decide/mutate split stays clean.
 */
export function tryPasteLink(editor: LexicalEditor, text: string): boolean {
  const url = text.trim();
  if (!isSingleUrl(url)) return false;

  let mode: "wrap" | "insert" | null = null;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    if (!selection.isCollapsed() && selection.getTextContent().length > 0) {
      mode = "wrap";
      return;
    }
    if (selection.isCollapsed()) {
      // Inside an existing link a nested link is invalid — leave it to default
      // paste (the URL lands as plain text within the link's own text).
      const anchorNode = selection.anchor.getNode();
      const inLink =
        $isLinkNode(anchorNode) ||
        $findMatchingParent(anchorNode, $isLinkNode) !== null;
      if (!inLink) mode = "insert";
    }
  });
  if (mode === null) return false;

  editor.update(() => {
    if (mode === "wrap") {
      // Wraps the selected text in a LinkNode (or, over an existing link,
      // replaces its URL) — serializes to `[text](url)` either way.
      $toggleLink(url);
      return;
    }
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return;
    const link = $createLinkNode(url);
    link.append($createTextNode(url));
    selection.insertNodes([link]);
    // insertNodes leaves the caret INSIDE the link; park it on the parent
    // element point just after the link instead, so typing continues unlinked.
    const parent = link.getParent();
    if (parent) {
      const after = link.getIndexWithinParent() + 1;
      parent.select(after, after);
    }
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
