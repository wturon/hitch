"use client";

import { forwardRef, type CSSProperties } from "react";
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

// The friendly, symbol-free body editor — a thin wrapper over MDXEditor so the
// dialog stays readable. WYSIWYG by default: typing `**x**`, `# `, `- `, etc.
// renders inline with no markers left behind (markdownShortcutPlugin). The
// editor holds a Lexical AST and re-serializes markdown on change, so it owns
// only the task *body* — frontmatter is split off upstream and never enters here
// (see TaskDialog / lib/frontmatter). The styling target is the "Reading"
// artboard: Geist type scale, monochrome code chips, real headings/lists.
//
// MDXEditor's `markdown` prop is set-once (like defaultValue); push later
// external edits through the forwarded ref's `setMarkdown`.
export const MarkdownEditor = forwardRef<
  MDXEditorMethods,
  {
    markdown: string;
    onChange: (markdown: string) => void;
    placeholder?: string;
    className?: string;
  }
>(function MarkdownEditor({ markdown, onChange, placeholder, className }, ref) {
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
      ref={ref}
      markdown={markdown}
      // Skip the change MDXEditor fires when it normalizes the *initial*
      // markdown (whitespace, bullet glyphs, etc.) — and the same echo from
      // `setMarkdown`. Forwarding it would mark a task dirty just by opening it,
      // rewriting files you only viewed. Real keystrokes have initial=false.
      onChange={(md, initialMarkdownNormalize) => {
        if (!initialMarkdownNormalize) onChange(md);
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
