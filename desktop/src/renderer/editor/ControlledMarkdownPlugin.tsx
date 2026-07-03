// The controlled value/onChange contract for `MarkdownEditor`, factored into its
// own plugin so it can be tested inside a minimal composer without the full
// component (styling, placeholder, focus handle) in the way.
//
// It re-creates the behavior of the old MDXEditor wrapper's controlled shim, but
// on raw Lexical: the `.md` string is the source of truth, this plugin is the
// only bridge between that string and the live editor state, and — critically —
// merely *opening* or *adopting* a document must never look like a user edit.
//
// ---------------------------------------------------------------------------
// Ref bookkeeping — ONE ref: the value prop the editor currently reflects
// ---------------------------------------------------------------------------
// `lastValueRef` always holds the `value` string that corresponds to what is in
// the editor right now — advanced on BOTH paths:
//
//   - a user edit: set to the markdown we exported and handed the parent, so
//     the parent echoing that string back is recognized and skipped;
//   - an adoption: set to the raw incoming bytes we imported, so a re-render
//     echoing a NON-canonical adoption (e.g. `* bullet`, which would export as
//     `- bullet` and so never round-trips to itself) is also skipped.
//
// A `value` prop is re-imported iff it differs from this ref — i.e. iff it is
// something the editor doesn't already reflect. Keeping ONE ref advanced on both
// paths (rather than separate last-emitted/last-adopted refs, each frozen while
// the other path is active) matters: a stale ref acts as a permanent "skip these
// exact bytes" filter, silently dropping a genuine external write whose bytes
// happen to match an *older* state — e.g. an agent reverting the file to exactly
// what was adopted before the user's last edit. With a single ref there is no
// stale value to match against: only the string the editor reflects *right now*
// is skipped, which is precisely the no-op case.
//
// Emission is driven by an update listener rather than OnChangePlugin so it can
// read the update's tags: our own programmatic imports carry HITCH_IMPORT_TAG and
// are skipped, so importing never fires onChange. The initial import doesn't
// even reach the listener — LexicalComposer runs the `editorState` init function
// before this plugin's effect registers — but we tag it consistently anyway.
import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { HISTORY_MERGE_TAG } from "lexical";

import { exportMarkdown, importMarkdown } from "./bridge";

// Marks an editor update as a programmatic import driven by this plugin (initial
// content or external adoption), so the change listener knows not to treat the
// resulting change as a user edit and re-emit it.
export const HITCH_IMPORT_TAG = "hitch-controlled-import";

export interface ControlledMarkdownPluginProps {
  value: string;
  onChange: (markdown: string) => void;
}

export function ControlledMarkdownPlugin({
  value,
  onChange,
}: ControlledMarkdownPluginProps) {
  const [editor] = useLexicalComposerContext();

  // The `value` string the editor currently reflects (see the header comment).
  // Seeded with the initial value, which the composer's `editorState` callback
  // already imported — so a first render that echoes it back is a no-op.
  const lastValueRef = useRef(value);
  // Keep onChange in a ref so the update listener (registered once) always calls
  // the latest callback without re-subscribing on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Emit on genuine user edits; stay silent for programmatic imports.
  useEffect(() => {
    return editor.registerUpdateListener(
      ({ editorState, dirtyElements, dirtyLeaves, tags }) => {
        // Pure selection/focus moves change no content — nothing to serialize.
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        // Skip programmatic, non-user commits:
        //   - HITCH_IMPORT_TAG: our own adoption import.
        //   - HISTORY_MERGE_TAG: the initial-content commit, which Lexical runs
        //     under this tag and can reconcile *after* this listener registers
        //     (once the contenteditable mounts) — that late settle would
        //     otherwise emit the opening document as if it were an edit. Lexical
        //     only sets history-merge on root mount/unmount and transform
        //     registration, never on keystrokes/paste/IME (and undo/redo carry
        //     the distinct `historic` tag), so this never eats a genuine edit.
        if (tags.has(HITCH_IMPORT_TAG) || tags.has(HISTORY_MERGE_TAG)) return;

        let markdown: string;
        try {
          markdown = editorState.read(() => exportMarkdown());
        } catch (error) {
          // A node the bridge can't serialize (shouldn't happen with our node
          // set, but this holds real user documents). Skip this emission rather
          // than let the throw unmount the editor tree.
          console.error("[MarkdownEditor] export failed; skipping onChange", error);
          return;
        }

        lastValueRef.current = markdown;
        onChangeRef.current(markdown);
      },
    );
  }, [editor]);

  // Adopt an externally-driven value change. A value the editor already reflects
  // (our own edit echoing back, or a re-render repeating an adoption) is skipped,
  // so the caret and history survive parent re-renders.
  useEffect(() => {
    if (value === lastValueRef.current) return;

    // A genuine external change (an agent rewrote the file). Import it, tagged so
    // the change listener skips the resulting event (no onChange) and
    // HISTORY_MERGE_TAG so adoption folds into history instead of leaving a stray
    // undo step the user can't reason about.
    //
    // The ref is advanced up front, deliberately including the failure case: if
    // importMarkdown throws inside the update, Lexical routes the error to the
    // composer's onError (which logs, and does not rethrow here) and rolls the
    // editor back to its pre-update state — so the outer catch below is
    // belt-and-braces, not the primary containment. Advancing the ref anyway
    // means we don't re-attempt a doomed import on every subsequent render; the
    // cost is that the editor keeps showing the previous document until the next
    // value change, which is the intended degraded behavior for unparseable input.
    lastValueRef.current = value;
    try {
      editor.update(() => importMarkdown(value), {
        tag: [HITCH_IMPORT_TAG, HISTORY_MERGE_TAG],
      });
    } catch (error) {
      console.error("[MarkdownEditor] import failed; keeping current document", error);
    }
  }, [editor, value]);

  return null;
}
