// The production body editor for Text Editor 2.0 — a Hitch-owned rich-text
// surface built directly on Lexical, replacing the MDXEditor wrapper. It carries
// the SAME name and public shape as that wrapper (`MarkdownEditor` +
// `MarkdownEditorHandle`) on purpose: flipping a surface (NotesView, TaskDialog)
// from the old editor to this one is a one-line import change, no prop churn.
//
// The controlled value/onChange contract lives in ControlledMarkdownPlugin (its
// own file, for testability); this component is the composer + chrome around it:
// the node set and markdown transformers (shared config, kept in lock-step with
// the sandbox), the plugin wiring, placeholder, styling, and the focus handle.
//
// Images and an overlay container are NOT props yet — they land with the image
// port. Kept off the type until then so callers don't depend on a no-op.
import { forwardRef, useImperativeHandle, useRef } from "react";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { $getRoot } from "lexical";

import { cn } from "@/lib/utils";
import { importMarkdown } from "./bridge";
import { EDITOR_NODES, MARKDOWN_TRANSFORMERS } from "./config";
import { ControlledMarkdownPlugin } from "./ControlledMarkdownPlugin";

// The imperative surface the editor exposes to its parent. Deliberately
// focus-only: content flows through the controlled `value`/`onChange` props, so
// the parent never reaches in to read or set the document. Focus routing (Enter
// in the title → body, click empty area → body) is cross-cutting and the editor
// can't own it — it doesn't know about the title — so the parent decides *when*
// and calls these. Mirrors the old MDXEditor wrapper's handle exactly.
export interface MarkdownEditorHandle {
  focusStart: () => void;
  focusEnd: () => void;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  className?: string;
}

// The composed editor body. Rendered inside the LexicalComposer so its plugins
// and the focus handle can reach the editor through context.
const EditorBody = forwardRef<
  MarkdownEditorHandle,
  { value: string; onChange: (markdown: string) => void; placeholder?: string }
>(function EditorBody({ value, onChange, placeholder }, ref) {
  const [editor] = useLexicalComposerContext();

  useImperativeHandle(
    ref,
    () => ({
      // Place the caret at the very start / end of the document, then move DOM
      // focus there. selectStart/selectEnd inside an update force the position
      // (editor.focus alone only creates a selection when none exists); focus()
      // then actually lands the cursor in the contenteditable.
      focusStart: () => {
        editor.update(() => {
          $getRoot().selectStart();
        });
        editor.focus(undefined, { defaultSelection: "rootStart" });
      },
      focusEnd: () => {
        editor.update(() => {
          $getRoot().selectEnd();
        });
        editor.focus(undefined, { defaultSelection: "rootEnd" });
      },
    }),
    [editor],
  );

  return (
    // `relative` so the placeholder can absolutely position onto the first line;
    // `min-h-full` on the editable makes the whole column the click target
    // (Lexical renders the placeholder as an unpositioned flow sibling, and the
    // editable would otherwise be only as tall as its content).
    <div className="relative min-h-0 flex-1">
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            className="hitch-editor-content min-h-full"
            aria-label="Editor"
            aria-placeholder={placeholder ?? ""}
            // Function form: ContentEditable's `placeholder` prop rejects a bare
            // `null`, so return the node (or null when there's no placeholder)
            // from a callback instead.
            placeholder={() =>
              placeholder ? (
                <div className="pointer-events-none absolute left-0 top-0 text-muted-foreground">
                  {placeholder}
                </div>
              ) : null
            }
          />
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      {/* Undo/redo. Adoption imports carry HISTORY_MERGE_TAG so they don't leave
          stray undo steps (see ControlledMarkdownPlugin). */}
      <HistoryPlugin />
      {/* Enter-to-new-item, backspace-to-outdent, Tab nesting for list nodes. */}
      <ListPlugin />
      <TabIndentationPlugin />
      {/* Wires the INSERT_HORIZONTAL_RULE command for `---`. */}
      <HorizontalRulePlugin />
      {/* Turns `# `, `- `, `> `, `**bold**`, `[text](url)` etc. into real nodes
          as you type, using our code-free transformer set. */}
      <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
      {/* The value/onChange bridge — the only path between the `.md` string and
          the live editor state. */}
      <ControlledMarkdownPlugin value={value} onChange={onChange} />
    </div>
  );
});

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ value, onChange, placeholder, className }, ref) {
    // The initial content is imported ONCE, here, via the composer's `editorState`
    // callback (Lexical runs it inside an update tagged HISTORY_MERGE before this
    // subtree's effects register). That's why opening never fires onChange: the
    // import lands before ControlledMarkdownPlugin's change listener exists. The
    // callback is stable across renders (captured once) so later `value` changes
    // flow through the plugin's adoption path, never a remount. `value` is
    // intentionally read only at mount — the ref-lint escape is deliberate.
    const initialValueRef = useRef(value);

    const initialConfig = useRef({
      namespace: "hitch-editor",
      nodes: [...EDITOR_NODES],
      editorState: () => {
        importMarkdown(initialValueRef.current);
      },
      onError(error: Error) {
        // Surface Lexical invariant violations loudly; they indicate a bug in our
        // node set or bridge, not user data we should swallow.
        console.error("[MarkdownEditor] Lexical error:", error);
      },
    }).current;

    return (
      <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
        <LexicalComposer initialConfig={initialConfig}>
          <EditorBody
            ref={ref}
            value={value}
            onChange={onChange}
            placeholder={placeholder}
          />
        </LexicalComposer>
      </div>
    );
  },
);
