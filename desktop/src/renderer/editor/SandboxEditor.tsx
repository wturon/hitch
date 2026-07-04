// Editor Sandbox — a bare, vanilla Lexical editor plus a live EditorState
// inspector. This is a learning/iteration surface for Text Editor 2.0 (the
// Hitch-owned editor that will replace MDXEditor); see
// `.hitch/notes/text-editor-2-0/index.md`. It ships alongside MDXEditor and
// shares no code with it — plain rich text is the whole point for now.
//
// Everything the editor needs lives in this folder; the only public entry is
// `editor/index.ts` (nothing outside the folder imports these files directly).

import { useMemo, useRef, useState } from "react";
import { XIcon, FileTextIcon } from "lucide-react";

import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { AutoFocusPlugin } from "@lexical/react/LexicalAutoFocusPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MarkdownShortcutPlugin } from "./shortcuts";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { TabIndentationPlugin } from "@lexical/react/LexicalTabIndentationPlugin";
import { HorizontalRulePlugin } from "@lexical/react/LexicalHorizontalRulePlugin";
import type { EditorState } from "lexical";

import { exportMarkdown, importMarkdown } from "./bridge";
import { EDITOR_NODES, MARKDOWN_TRANSFORMERS } from "./config";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { SlashMenuPlugin } from "./SlashMenuPlugin";

const initialConfig = {
  namespace: "hitch-editor-sandbox",
  // The shared node set (see config.ts) — kept in lock-step with the production
  // MarkdownEditor and the bridge test harness. No `CodeNode`.
  nodes: [...EDITOR_NODES],
  onError(error: Error) {
    // Lexical throws on internal invariants; surface them loudly while we learn
    // rather than swallowing them.
    console.error("[SandboxEditor] Lexical error:", error);
  },
};

// The sandbox has two modes: the raw "vanilla" Lexical playground (state
// inspector + live markdown, for iterating on the engine) and a "component" mode
// that drives the production <MarkdownEditor> from real React state — the manual
// QA surface for the controlled contract (see ComponentHarness).
type SandboxMode = "vanilla" | "component";

export function SandboxEditor({ onExit }: { onExit: () => void }) {
  const [mode, setMode] = useState<SandboxMode>("vanilla");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header — title + mode toggle + exit affordance. */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-3">
          <div className="size-2 rounded-full bg-foreground" />
          <span className="text-[17px] font-semibold tracking-tight">
            Editor Sandbox
          </span>
          {/* Switch between the raw engine playground and the real component. */}
          <div className="flex items-center gap-1 rounded-full border border-border p-0.5">
            {(["vanilla", "component"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={
                  mode === value
                    ? "rounded-full bg-foreground px-2.5 py-0.5 font-mono text-[11px] text-background"
                    : "rounded-full px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                }
              >
                {value === "vanilla" ? "lexical · vanilla" : "component"}
              </button>
            ))}
          </div>
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

      {mode === "vanilla" ? <VanillaSandbox /> : <ComponentHarness />}
    </div>
  );
}

// The original raw-Lexical playground: a bare editor plus a live EditorState
// inspector and markdown pane, for iterating on the bridge and engine.
function VanillaSandbox() {
  return (
    <LexicalComposer initialConfig={initialConfig}>
      {/* Body: editor left; live EditorState inspector + Markdown pane right. */}
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
            {/* `/` block picker — the same slash menu the production editor
                mounts, so it can be exercised here in the raw playground. */}
            <SlashMenuPlugin />
            </div>
          </div>
          {/* Right column: EditorState inspector on top, live markdown below. */}
          <div className="flex w-[380px] shrink-0 flex-col gap-3">
            <StateInspector />
            <MarkdownPane />
          </div>
        </div>
      </LexicalComposer>
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
// a blockquote, a divider, an editable fenced code block, and one unsupported
// construct that lands in an opaque UnknownBlockNode). Authored in the bridge's
// canonical output form, so loading it and reading the Markdown pane shows
// byte-identical text.
// A tiny (8×8) real PNG, inlined as a data: URL so the sample renders an actual
// image with no network dependency (the bridge round-trips the whole `![](…)`).
const SAMPLE_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQvbIfK2IYWhIAns1wAWMqv18AAAAASUVORK5CYII=";

const SAMPLE_MARKDOWN = `# Editor bridge sample

A paragraph with **bold**, *italic*, and \`inline code\`.

An inline image ![a tiny square](${SAMPLE_IMAGE_DATA_URL}) sits mid-sentence.

## A nested list

- First item
- Second item
  - Nested item a
  - Nested item b

1. Step one
2. Step two

> A short blockquote with a [link](https://example.com).

## A code block

\`\`\`ts
const kept = "verbatim";
\`\`\`

---

## Unsupported constructs

The bridge doesn't model this yet, so it lands in a read-only unknown block and
round-trips byte-for-byte:

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

// A deliberately NON-canonical doc for the "Set external value" button: `*`
// bullets and `_emphasis_` that the bridge re-serializes to `-` bullets and
// `*emphasis*`. Pushing it through the `value` prop proves invariant C — the
// editor adopts it silently (no onChange), and the change counter stays put
// until you actually type.
const EXTERNAL_SAMPLE = `# Rewritten by an agent

This paragraph arrived through the *value* prop, not the keyboard.

* first star bullet
* second star bullet

Nothing here should tick the onChange counter.
`;

// Manual-QA surface for the production MarkdownEditor: drives it from real React
// state so you can watch the controlled contract behave. Left pane is the live
// editor; right pane shows the current `value` string, an onChange counter, and
// buttons to push an external value in and exercise the focus handle.
function ComponentHarness() {
  const [value, setValue] = useState<string>(
    `# Component mode

Type here — watch \`value\` and the onChange counter update.

Click the [funnel dashboard](https://example.com/dash) link to open the popover — copy, edit, or unwrap it. Select text and paste a URL to link it.

An image loads through the fake preview handler (note the Skeleton for ~800ms):

![a tiny square](${SAMPLE_IMAGE_DATA_URL})

Paste an image from your clipboard to upload + insert it inline.
`,
  );
  const [changeCount, setChangeCount] = useState(0);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  // Fake handlers so the whole image feature is demoable without Convex.
  // Preview: an ~800ms artificial delay then the src unchanged — long enough to
  // watch the Skeleton before the <img> swaps in. Upload: read the pasted file
  // to a data: URL, so pasting a real clipboard image renders immediately.
  const imagePreviewHandler = useMemo(
    () => (src: string) =>
      new Promise<string>((resolve) => setTimeout(() => resolve(src), 800)),
    [],
  );
  const imageUploadHandler = useMemo(
    () => (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }),
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-row gap-4 pt-4">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {/* Controls: push a non-canonical external value, drive the focus handle. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setValue(EXTERNAL_SAMPLE)}
            className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
          >
            <FileTextIcon className="size-3.5 text-muted-foreground" />
            Set external value
          </button>
          <button
            type="button"
            onClick={() => editorRef.current?.focusStart()}
            className="flex h-8 items-center rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
          >
            Focus start
          </button>
          <button
            type="button"
            onClick={() => editorRef.current?.focusEnd()}
            className="flex h-8 items-center rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground hover:bg-muted"
          >
            Focus end
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-[10px] border border-border px-3.5 py-3">
          <MarkdownEditor
            ref={editorRef}
            value={value}
            onChange={(md) => {
              setChangeCount((n) => n + 1);
              setValue(md);
            }}
            placeholder="Start typing…"
            imageUploadHandler={imageUploadHandler}
            imagePreviewHandler={imagePreviewHandler}
          />
        </div>
      </div>
      {/* Right column: onChange counter on top, the live `value` string below. */}
      <div className="flex w-[380px] shrink-0 flex-col gap-3">
        <div className="flex shrink-0 items-center justify-between rounded-[10px] border border-border bg-secondary px-3.5 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            onChange calls
          </span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">
            {changeCount}
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border">
          <div className="flex shrink-0 items-center justify-between border-b border-border bg-secondary px-3.5 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              value (parent state)
            </span>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3.5 py-3 font-mono text-[11px] leading-[1.5] text-foreground">
            {value || "// empty"}
          </pre>
        </div>
      </div>
    </div>
  );
}
