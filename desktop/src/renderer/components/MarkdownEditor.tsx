"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  markdownShortcutPlugin,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

import { cn } from "@/lib/utils";

// Languages offered for fenced code blocks. The empty key is the fallback for
// unlabelled ``` fences so they round-trip instead of erroring; the rest cover
// the languages a task doc is likely to paste in.
const CODE_BLOCK_LANGUAGES = {
  "": "Plain text",
  text: "Plain text",
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  bash: "Shell",
  sh: "Shell",
  css: "CSS",
  html: "HTML",
  md: "Markdown",
  py: "Python",
} as const;

// The imperative surface the editor exposes to its parent. Deliberately
// focus-only: content flows through the controlled `value`/`onChange` props, so
// the parent never reaches in to read or set the document. Focus routing
// (Enter in the title → body, click empty area → body) is cross-cutting and the
// editor can't own it — it doesn't know about the title — so the parent decides
// *when* and calls these.
export interface MarkdownEditorHandle {
  focusStart: () => void;
  focusEnd: () => void;
}

// The friendly, symbol-free body editor — a thin wrapper over MDXEditor and the
// ONLY place that knows about MDXEditor's quirks. WYSIWYG by default: typing
// `**x**`, `# `, `- `, etc. renders inline with no markers left behind
// (markdownShortcutPlugin). The editor holds a Lexical AST and re-serializes
// markdown on change, so it owns only the task *body* — frontmatter is split off
// upstream and never enters here (see useTaskDraft / lib/frontmatter). The
// styling target is the "Reading" artboard: Geist type scale, monochrome code
// chips, real headings/lists.
//
// Controlled value/onChange API: MDXEditor's `markdown` prop is set-once (like
// defaultValue) and the only way to push a later value in is the imperative
// `setMarkdown`. We hide that here. We track our own last-emitted value and call
// `setMarkdown` only when an incoming `value` differs from it — so a parent
// re-render that just echoes our own edit back is a no-op (no cursor reset),
// while a genuine external change (adoption of an outside write) flows in.
export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  {
    value: string;
    onChange: (markdown: string) => void;
    placeholder?: string;
    className?: string;
  }
>(function MarkdownEditor({ value, onChange, placeholder, className }, ref) {
  const editorRef = useRef<MDXEditorMethods>(null);
  // The markdown we last handed to the parent (or pushed in via setMarkdown).
  // Incoming `value` props are diffed against this, NOT against MDXEditor's live
  // content: only a value the editor didn't itself produce warrants a setMarkdown.
  const lastEmittedRef = useRef(value);

  useImperativeHandle(ref, () => ({
    focusStart: () =>
      editorRef.current?.focus(undefined, { defaultSelection: "rootStart" }),
    focusEnd: () =>
      editorRef.current?.focus(undefined, { defaultSelection: "rootEnd" }),
  }));

  // Adopt an externally-driven value change. When `value` matches what we last
  // emitted this is our own edit echoing back — skip it so the caret stays put.
  // The `setMarkdown` echo arrives back through `onChange` with the initial flag
  // set (see below), so it never re-fires `onChange` and never loops.
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editorRef.current?.setMarkdown(value);
  }, [value]);

  // The empty-state placeholder is drawn by CSS as a `::before` on the editor's
  // own empty paragraph (see styles.css), NOT MDXEditor's absolute overlay —
  // the overlay's position depends on a positioning context our flex layout
  // disturbs, which left it misaligned from the caret. As pseudo-content of the
  // real first line, the `::before` is always exactly in line with the cursor.
  // The text rides in via a CSS variable (must be a quoted string for `content`).
  return (
    <div
      className={cn("hitch-mdx-host", className)}
      style={
        placeholder
          ? ({ "--hitch-md-placeholder": `"${placeholder}"` } as CSSProperties)
          : undefined
      }
    >
    <MDXEditor
      ref={editorRef}
      markdown={value}
      // Skip the change MDXEditor fires when it normalizes the *initial*
      // markdown (whitespace, bullet glyphs, etc.) — and the same echo from
      // `setMarkdown`. Forwarding it would mark a task dirty just by opening it
      // (or adopting an external write), rewriting files you only viewed. Real
      // keystrokes have initial=false; only those advance lastEmitted + onChange.
      onChange={(md, initialMarkdownNormalize) => {
        if (initialMarkdownNormalize) return;
        lastEmittedRef.current = md;
        onChange(md);
      }}
      // Task bodies can contain markdown the enabled plugins don't model (raw
      // HTML, the odd directive). Don't process HTML (pass it through as text)
      // and swallow parse errors so a stray construct degrades instead of
      // crashing the dialog.
      suppressHtmlProcessing
      onError={({ error, source }) =>
        console.warn("MarkdownEditor parse issue:", error, source)
      }
      // Serialize with `-` bullets (MDXEditor defaults to `*`), matching how
      // task docs are authored — keeps the save diff to the actual edit.
      toMarkdownOptions={{ bullet: "-" }}
      className="hitch-mdx"
      contentEditableClassName="hitch-mdx-content"
      plugins={[
        headingsPlugin(),
        listsPlugin(),
        quotePlugin(),
        thematicBreakPlugin(),
        linkPlugin(),
        linkDialogPlugin(),
        codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
        codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
        markdownShortcutPlugin(),
      ]}
    />
    </div>
  );
});
