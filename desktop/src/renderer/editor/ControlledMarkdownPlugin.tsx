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
// Ref bookkeeping — why TWO refs (lastEmitted + lastAdopted)
// ---------------------------------------------------------------------------
// A value prop can arrive for three different reasons, and only ONE of them
// should re-import into the editor:
//
//   1. It echoes our own last edit  (parent re-render after our onChange)  → skip
//   2. It echoes a value we just adopted (parent re-render, no user edit)  → skip
//   3. It's genuinely new (an agent rewrote the file underneath us)        → import
//
// `lastEmittedRef` tracks the last markdown a *user edit* handed the parent (case
// 1). `lastAdoptedRef` tracks the last raw markdown we *imported* into the editor
// — the initial value, or an external adoption (case 2).
//
// Both are needed because of the non-canonical-adoption trap. When we adopt an
// external value like `* bullet` (non-canonical: export would emit `- bullet`),
// the string sitting in the editor no longer round-trips to itself. If we tracked
// only `lastEmitted`, the very next parent re-render that passed `* bullet` back
// would fail the "is this my own edit?" test and re-import — wiping history and
// jumping the caret on every unrelated re-render (case 2 misread as case 3).
// `lastAdoptedRef` remembers the exact bytes we adopted, so echoes of a
// non-canonical adoption are recognized and skipped.
//
// The other half of the trap is handled for free: after adoption the user's next
// keystroke exports canonical markdown (`- bullet …`), the change listener sets
// `lastEmittedRef` to it and emits once, and when that canonical string comes
// back as `value` it matches `lastEmittedRef` → no re-import. No loop, no
// spurious dirty (invariants C→D).
//
// Emission is driven by an update listener rather than OnChangePlugin so it can
// read the update's tags: our own programmatic imports carry HITCH_IMPORT_TAG and
// are skipped, so importing never fires onChange (invariants A and C). The
// initial import doesn't even reach the listener — LexicalComposer runs the
// `editorState` init function before this plugin's effect registers — but we tag
// it consistently anyway.
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

  // The markdown a user edit last handed the parent (case 1 above). Seeded with
  // the initial value, which the composer's `editorState` callback already
  // imported — so a first render that echoes it back is correctly a no-op.
  const lastEmittedRef = useRef(value);
  // The raw markdown we last imported into the editor (case 2 above): the initial
  // value, then whatever we adopt. Distinct from lastEmitted so non-canonical
  // adoptions don't re-import on every echoing re-render.
  const lastAdoptedRef = useRef(value);
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
        //   - HITCH_IMPORT_TAG: our own adoption import (invariant C).
        //   - HISTORY_MERGE_TAG: the initial-content commit, which Lexical runs
        //     under this tag and can reconcile *after* this listener registers
        //     (once the contenteditable mounts) — that late settle would
        //     otherwise emit the opening document as if it were an edit
        //     (invariant A). Real keystrokes never carry history-merge, so this
        //     never eats a genuine edit.
        if (tags.has(HITCH_IMPORT_TAG) || tags.has(HISTORY_MERGE_TAG)) return;

        let markdown: string;
        try {
          markdown = editorState.read(() => exportMarkdown());
        } catch (error) {
          // A node the bridge can't serialize (shouldn't happen with our node
          // set, but this holds real user documents). Skip this emission rather
          // than let the throw unmount the editor tree (invariant E).
          console.error("[MarkdownEditor] export failed; skipping onChange", error);
          return;
        }

        lastEmittedRef.current = markdown;
        onChangeRef.current(markdown);
      },
    );
  }, [editor]);

  // Adopt an externally-driven value change. Skip the two echo cases so the caret
  // and history survive a parent re-render that merely hands our own content back.
  useEffect(() => {
    if (value === lastEmittedRef.current) return; // case 1: our own edit echoing
    if (value === lastAdoptedRef.current) return; // case 2: an adoption echoing

    // case 3: a genuine external change. Import it, tagged so the change listener
    // skips the resulting event (no onChange) and HISTORY_MERGE_TAG so adoption
    // folds into history instead of leaving a stray undo step the user can't
    // reason about.
    lastAdoptedRef.current = value;
    try {
      editor.update(() => importMarkdown(value), {
        tag: [HITCH_IMPORT_TAG, HISTORY_MERGE_TAG],
      });
    } catch (error) {
      // Unparseable/unsupported incoming markdown. Keep the current document
      // rather than blowing away the editor (invariant E).
      console.error("[MarkdownEditor] import failed; keeping current document", error);
    }
  }, [editor, value]);

  return null;
}
