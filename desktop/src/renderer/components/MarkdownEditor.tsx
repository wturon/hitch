"use client";

import {
  useCallback,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  MDXEditor,
  type MDXEditorMethods,
  ImageNode,
  addComposerChild$,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  imagePlugin,
  markdownShortcutPlugin,
  realmPlugin,
} from "@mdxeditor/editor";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $nodesOfType, type NodeKey } from "lexical";
import "@mdxeditor/editor/style.css";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
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

function subscribeToDocumentTheme(onStoreChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });

  return () => observer.disconnect();
}

function documentThemeSnapshot(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
  );
}

function useDocumentDarkTheme(): boolean {
  return useSyncExternalStore(
    subscribeToDocumentTheme,
    documentThemeSnapshot,
    () => false,
  );
}

interface ClipboardBridge {
  copyImageFromUrl?: (url: string) => Promise<void>;
}

interface ImageContextMenuState {
  x: number;
  y: number;
  nodeKey: NodeKey;
  src: string;
}

async function copyImageBlobToClipboard(blob: Blob) {
  if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
    throw new Error("Image clipboard writes are not available");
  }
  const type = blob.type || "image/png";
  const item = new ClipboardItem({ [type]: blob });
  await navigator.clipboard.write([item]);
}

async function copyImageToClipboard(
  src: string,
  imagePreviewHandler: ((src: string) => Promise<string>) | undefined,
) {
  const resolvedSrc = imagePreviewHandler
    ? await imagePreviewHandler(src)
    : src;
  try {
    const res = await fetch(resolvedSrc);
    if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
    await copyImageBlobToClipboard(await res.blob());
    return;
  } catch (err) {
    const bridge =
      typeof window !== "undefined"
        ? (window.hitchDaemon as ClipboardBridge | undefined)
        : undefined;
    if (!bridge?.copyImageFromUrl) throw err;
    await bridge.copyImageFromUrl(resolvedSrc);
  }
}

function MarkdownImageContextMenu({
  imagePreviewHandler,
}: {
  imagePreviewHandler?: (src: string) => Promise<string>;
}) {
  const [editor] = useLexicalComposerContext();
  const [menu, setMenu] = useState<ImageContextMenuState | null>(null);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(
    null,
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;

    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const imageWrapper = target.closest('[data-editor-block-type="image"]');
      if (!(imageWrapper instanceof HTMLElement)) return;

      let nextMenu: ImageContextMenuState | null = null;
      editor.getEditorState().read(() => {
        for (const node of $nodesOfType(ImageNode)) {
          const element = editor.getElementByKey(node.getKey());
          if (element?.contains(imageWrapper)) {
            nextMenu = {
              x: event.clientX,
              y: event.clientY,
              nodeKey: node.getKey(),
              src: node.getSrc(),
            };
            break;
          }
        }
      });
      if (!nextMenu) return;

      event.preventDefault();
      event.stopPropagation();
      setCopyStatus(null);
      setMenu(nextMenu);
    };

    root.addEventListener("contextmenu", onContextMenu, true);
    return () => root.removeEventListener("contextmenu", onContextMenu, true);
  }, [editor]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(null), 1800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [copyStatus]);

  const copyImage = useCallback(() => {
    if (!menu) return;
    const src = menu.src;
    closeMenu();
    void copyImageToClipboard(src, imagePreviewHandler)
      .then(() => setCopyStatus("copied"))
      .catch((err) => {
        console.error("Image copy failed", err);
        setCopyStatus("failed");
      });
  }, [closeMenu, imagePreviewHandler, menu]);

  const deleteImage = useCallback(() => {
    if (!menu) return;
    const nodeKey = menu.nodeKey;
    closeMenu();
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if (node instanceof ImageNode) node.remove();
    });
  }, [closeMenu, editor, menu]);

  const anchor = useMemo(() => {
    if (!menu) return null;
    return {
      getBoundingClientRect: () =>
        DOMRect.fromRect({
          x: menu.x,
          y: menu.y,
          width: 0,
          height: 0,
        }),
    };
  }, [menu]);

  return (
    <ContextMenu
      open={Boolean(menu)}
      onOpenChange={(open) => {
        if (!open) closeMenu();
      }}
    >
      <ContextMenuContent
        anchor={anchor}
        side="bottom"
        align="start"
        sideOffset={0}
        collisionPadding={8}
      >
        <ContextMenuItem onClick={copyImage}>Copy Image</ContextMenuItem>
        <ContextMenuItem variant="destructive" onClick={deleteImage}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
      {copyStatus && (
        <div
          role="status"
          className={cn(
            "fixed right-4 bottom-4 z-50 rounded-md border bg-card px-3 py-2 text-xs shadow-lg",
            copyStatus === "failed" && "text-destructive",
          )}
        >
          {copyStatus === "copied" ? "Image copied" : "Could not copy image"}
        </div>
      )}
    </ContextMenu>
  );
}

const imageContextMenuPlugin = realmPlugin<{
  imagePreviewHandler?: (src: string) => Promise<string>;
}>({
  init(realm, params) {
    realm.pub(addComposerChild$, () => (
      <MarkdownImageContextMenu
        imagePreviewHandler={params?.imagePreviewHandler}
      />
    ));
  },
});

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
    overlayContainer?: HTMLElement | null;
    // When both are set, MDXEditor's image plugin is enabled: clipboard paste of
    // an image uploads it (imageUploadHandler returns the relative path written
    // as the markdown `src`) and inline display resolves that path to a signed
    // URL (imagePreviewHandler). Supplied by the parent via useAttachments;
    // file *drop* is handled at the dialog level, not here.
    imageUploadHandler?: (file: File) => Promise<string>;
    imagePreviewHandler?: (src: string) => Promise<string>;
  }
>(function MarkdownEditor(
  {
    value,
    onChange,
    placeholder,
    className,
    overlayContainer,
    imageUploadHandler,
    imagePreviewHandler,
  },
  ref,
) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const isDarkTheme = useDocumentDarkTheme();
  // The markdown we last handed to the parent (or pushed in via setMarkdown).
  // Incoming `value` props are diffed against this, NOT against MDXEditor's live
  // content: only a value the editor didn't itself produce warrants a setMarkdown.
  const lastEmittedRef = useRef(value);
  const imagesEnabled = Boolean(imageUploadHandler && imagePreviewHandler);
  const editorPlugins = useMemo(
    () => [
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      linkDialogPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
      // Image paste + inline rendering, only when the parent supplied both
      // handlers. The upload handler returns the relative path written as the
      // markdown `src`; the preview handler resolves it to a signed URL.
      ...(imagesEnabled
        ? [
            imagePlugin({
              imageUploadHandler,
              imagePreviewHandler,
              disableImageSettingsButton: true,
            }),
            imageContextMenuPlugin({ imagePreviewHandler }),
          ]
        : []),
      markdownShortcutPlugin(),
    ],
    [imagePreviewHandler, imageUploadHandler, imagesEnabled],
  );

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
        className={cn("hitch-mdx", isDarkTheme && "dark-theme")}
        contentEditableClassName="hitch-mdx-content"
        overlayContainer={overlayContainer ?? undefined}
        plugins={editorPlugins}
      />
    </div>
  );
});
