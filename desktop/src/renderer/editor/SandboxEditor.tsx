// Editor Sandbox — a bare, vanilla Lexical editor plus a live EditorState
// inspector. This is a learning/iteration surface for Text Editor 2.0 (the
// Hitch-owned editor that will replace MDXEditor); see
// `.hitch/notes/text-editor-2-0/index.md`. It ships alongside MDXEditor and
// shares no code with it — plain rich text is the whole point for now.
//
// Everything the editor needs lives in this folder; the only public entry is
// `editor/index.ts` (nothing outside the folder imports these files directly).

import { useRef, useState } from "react";
import { XIcon, FileTextIcon } from "lucide-react";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import {
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  LINK,
  TEXT_FORMAT_TRANSFORMERS,
  type Transformer,
} from "@lexical/markdown";
import type { EditorState } from "lexical";

import { exportMarkdown, importMarkdown } from "./bridge";
import { UnknownBlockNode } from "./nodes/UnknownBlockNode";

// Explicit transformer set — deliberately NOT the default `TRANSFORMERS` from
// `@lexical/markdown`. That default bundles the fenced-code-block transformer,
// which pulls in `CodeNode`/`CodeHighlightNode` from `@lexical/code` and its
// Prism global — exactly the dependency Text Editor 2.0 is escaping. So we
// assemble only the block, inline-format, and link transformers by hand. Code
// blocks are intentionally out of scope.
//
// Order mirrors the default array's shape: element (block) transformers first,
// then inline text-format transformers, then text-match transformers (LINK).
const MARKDOWN_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  UNORDERED_LIST,
  ORDERED_LIST,
  ...TEXT_FORMAT_TRANSFORMERS,
  LINK,
];

const initialConfig = {
  namespace: "hitch-editor-sandbox",
  // Block + inline nodes the markdown shortcuts restructure the tree into.
  // No `CodeNode` — code blocks are out of scope (see MARKDOWN_TRANSFORMERS).
  // HorizontalRuleNode backs `---`; UnknownBlockNode preserves any markdown the
  // bridge doesn't model (see nodes/UnknownBlockNode.tsx). Keep in sync with the
  // bridge test harness's node list.
  nodes: [
    HeadingNode,
    QuoteNode,
    ListNode,
    ListItemNode,
    LinkNode,
    HorizontalRuleNode,
    UnknownBlockNode,
  ],
  onError(error: Error) {
    // Lexical throws on internal invariants; surface them loudly while we learn
    // rather than swallowing them.
    console.error("[SandboxEditor] Lexical error:", error);
  },
};

export function SandboxEditor({ onExit }: { onExit: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — title + exit affordance, mirroring DebugView's shape. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <div className="size-2 rounded-full bg-foreground" />
          <span className="text-[17px] font-semibold tracking-tight">
            Editor Sandbox
          </span>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            lexical · vanilla
          </span>
        </div>
        <button
          type="button"
          onClick={onExit}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
        >
          <XIcon className="size-3.5 text-muted-foreground" />
          Close
        </button>
      </div>

      {/* Body: editor left; live EditorState inspector + Markdown pane right. */}
      <LexicalComposer initialConfig={initialConfig}>
        <div className="flex min-h-0 flex-1 flex-row gap-4 pt-4">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            {/* Exercises the import direction: fills the editor from a canned
                markdown doc so you can watch it render. */}
            <SampleLoader />
            {/* `relative` so the placeholder can absolutely position onto the
                first line; `min-h-full` on the editable makes the whole column
                the click target (Lexical renders the placeholder as an
                unpositioned flow sibling, and the editable is otherwise only
                ~180px tall). */}
            <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
              <RichTextPlugin
              contentEditable={
                <ContentEditable
                  className="hitch-sandbox-content min-h-full"
                  aria-label="Editor sandbox"
                  aria-placeholder="Start typing…"
                  placeholder={
                    <div className="pointer-events-none absolute left-0 top-0 text-muted-foreground">
                      Start typing…
                    </div>
                  }
                />
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            <HistoryPlugin />
            <AutoFocusPlugin />
            {/* Turns `# `, `- `, `> `, `**bold**`, `[text](url)` etc. into real
                block/inline nodes as you type — watch the tree update in the
                inspector. Uses our code-free transformer set. */}
            <MarkdownShortcutPlugin transformers={MARKDOWN_TRANSFORMERS} />
            {/* Enter-to-new-item, backspace-to-outdent, and Tab nesting for the
                list nodes registered above. */}
            <ListPlugin />
            <TabIndentationPlugin />
            {/* Wires up the INSERT_HORIZONTAL_RULE command + selection handling
                for the HorizontalRuleNode registered above (`---`). */}
            <HorizontalRulePlugin />
            </div>
          </div>
          {/* Right column: EditorState inspector on top, live markdown below. */}
          <div className="flex w-[380px] shrink-0 flex-col gap-3">
            <StateInspector />
            <MarkdownPane />
          </div>
        </div>
      </LexicalComposer>
    </div>
  );
}

// The learning tool: renders the current EditorState.toJSON() as pretty JSON,
// re-serializing on every change so you can watch the node tree as you type.
function StateInspector() {
  const [json, setJson] = useState<string>("");
  const [open, setOpen] = useState(true);
  // Keep the latest state cheaply (no serialization) so we can render fresh JSON
  // the moment the pane is reopened, without stringifying on every keystroke
  // while it's collapsed — that cost would balloon on large pasted documents.
  const latest = useRef<EditorState | null>(null);

  function onChange(editorState: EditorState) {
    latest.current = editorState;
    if (open) setJson(JSON.stringify(editorState.toJSON(), null, 2));
  }

  function toggle() {
    setOpen((wasOpen) => {
      const nowOpen = !wasOpen;
      if (nowOpen && latest.current) {
        setJson(JSON.stringify(latest.current.toJSON(), null, 2));
      }
      return nowOpen;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border">
      <button
        type="button"
        onClick={toggle}
        className="flex shrink-0 items-center justify-between border-b border-border bg-secondary px-3.5 py-2 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          EditorState
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open ? (
        <pre className="min-h-0 flex-1 overflow-auto px-3.5 py-3 font-mono text-[11px] leading-[1.5] text-foreground">
          {json || "// type to see the editor state"}
        </pre>
      ) : null}
      {/* OnChangePlugin lives inside the composer via SandboxEditor; we render it
          here so the inspector owns the state it displays. */}
      <OnChangePlugin onChange={onChange} />
    </div>
  );
}

// A canonical markdown doc for the "Load sample" button — exercises the import
// direction (headings, nested lists of both kinds, bold/italic/code, a link,
// a blockquote, a divider, and two unsupported constructs that land in opaque
// UnknownBlockNodes). Authored in the bridge's canonical output form, so loading
// it and reading the Markdown pane shows byte-identical text.
const SAMPLE_MARKDOWN = `# Editor bridge sample

A paragraph with **bold**, *italic*, and \`inline code\`.

## A nested list

- First item
- Second item
  - Nested item a
  - Nested item b

1. Step one
2. Step two

> A short blockquote with a [link](https://example.com).

---

## Unsupported constructs

The bridge doesn't model these yet, so each lands in a read-only unknown block
and round-trips byte-for-byte:

\`\`\`ts
const kept = "verbatim";
\`\`\`

| Name | Role |
| ---- | ---- |
| Ada  | Eng  |
`;

// Fills the editor from SAMPLE_MARKDOWN via the import bridge. Lives inside the
// composer so it can reach the editor through context.
function SampleLoader() {
  const [editor] = useLexicalComposerContext();
  return (
    <button
      type="button"
      onClick={() => {
        editor.update(() => {
          importMarkdown(SAMPLE_MARKDOWN);
        });
      }}
      className="flex h-8 shrink-0 items-center gap-1.5 self-start rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
    >
      <FileTextIcon className="size-3.5 text-muted-foreground" />
      Load sample
    </button>
  );
}

// Live markdown serialization of the editor via the export bridge. Mirrors the
// StateInspector's collapsed-pane guard: while hidden it keeps only the latest
// EditorState (cheap) and defers the serialize until reopened, so a large pasted
// doc isn't re-serialized on every keystroke behind a closed pane. If export
// throws (e.g. an unsupported node), the error message is shown in place instead
// of crashing the sandbox.
function MarkdownPane() {
  const [markdown, setMarkdown] = useState<string>("");
  const [isError, setIsError] = useState(false);
  const [open, setOpen] = useState(true);
  const latest = useRef<EditorState | null>(null);

  function serialize(editorState: EditorState) {
    try {
      let out = "";
      editorState.read(() => {
        out = exportMarkdown();
      });
      setMarkdown(out);
      setIsError(false);
    } catch (error) {
      setMarkdown(error instanceof Error ? error.message : String(error));
      setIsError(true);
    }
  }

  function onChange(editorState: EditorState) {
    latest.current = editorState;
    if (open) serialize(editorState);
  }

  function toggle() {
    setOpen((wasOpen) => {
      const nowOpen = !wasOpen;
      if (nowOpen && latest.current) {
        serialize(latest.current);
      }
      return nowOpen;
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border">
      <button
        type="button"
        onClick={toggle}
        className="flex shrink-0 items-center justify-between border-b border-border bg-secondary px-3.5 py-2 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          Markdown
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {open ? "hide" : "show"}
        </span>
      </button>
      {open ? (
        <pre
          className={
            isError
              ? "min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3.5 py-3 font-mono text-[11px] leading-[1.5] text-destructive"
              : "min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3.5 py-3 font-mono text-[11px] leading-[1.5] text-foreground"
          }
        >
          {isError ? `export error: ${markdown}` : markdown || "// type to see markdown"}
        </pre>
      ) : null}
      <OnChangePlugin onChange={onChange} />
    </div>
  );
}
