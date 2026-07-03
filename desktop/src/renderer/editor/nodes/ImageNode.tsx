// An inline image node. mdast models `image` as an INLINE construct that lives
// inside a paragraph's phrasing content (`text ![a](b) more`), so this node is
// `isInline() === true` — that's what lets an image sit mid-sentence and still
// round-trip byte-exact through the bridge.
//
// The three fields (`__src`, `__alt`, `__title`) are the whole of `![alt](src
// "title")`. `__title` is preserved as `string | null` specifically so the
// optional title round-trips: `![a](p "t")` in must come back out unchanged.
//
// Rendering is a decorator (`ImageComponent`), which owns the async src
// resolution, the loading Skeleton, the error/retry box, and node-selection.
// It pulls its preview handler from `ImageHandlersContext` — decorators render
// inside the LexicalComposer React tree, so context reaches them. Modelled on
// UnknownBlockNode for the class conventions.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement } from "react";
import { ImageOffIcon } from "lucide-react";

import {
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from "lexical";
import type {
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { useLexicalNodeSelection } from "@lexical/react/useLexicalNodeSelection";
import { mergeRegister } from "@lexical/utils";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// The handlers a host surface (MarkdownEditor) threads into the decorator tree.
// `previewHandler` resolves a stored markdown `src` (e.g. `attachments/x.png`)
// to something an <img> can actually load (a signed URL); absent it, the raw
// `src` is used as-is so plain https/data URLs still render. Provided via
// `ImageHandlersContext.Provider` in MarkdownEditor; the default (no handler)
// keeps the sandbox/bridge working without any wiring.
export interface ImageHandlers {
  previewHandler?: (src: string) => Promise<string>;
}

export const ImageHandlersContext = createContext<ImageHandlers>({});

// Retry policy for the post-upload race: right after an upload the preview
// handler can briefly resolve an `attachments/…` src to the *unresolved* path
// because the attachments query is an in-memory row lookup that hasn't caught up
// (see hooks/useAttachments.ts). So on an <img> error for an attachments src, we
// re-resolve a few times with a short backoff before settling into the error box.
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 5;

export type SerializedImageNode = Spread<
  { src: string; alt: string; title: string | null },
  SerializedLexicalNode
>;

export class ImageNode extends DecoratorNode<ReactElement> {
  readonly __src: string;
  readonly __alt: string;
  readonly __title: string | null;

  static getType(): string {
    return "image";
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__alt, node.__title, node.__key);
  }

  static importJSON(serialized: SerializedImageNode): ImageNode {
    return $createImageNode(serialized.src, serialized.alt, serialized.title);
  }

  constructor(src: string, alt: string, title: string | null, key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__alt = alt;
    this.__title = title;
  }

  exportJSON(): SerializedImageNode {
    return {
      ...super.exportJSON(),
      type: ImageNode.getType(),
      version: 1,
      src: this.__src,
      alt: this.__alt,
      title: this.__title,
    };
  }

  getSrc(): string {
    return this.__src;
  }

  getAltText(): string {
    return this.__alt;
  }

  getTitle(): string | null {
    return this.__title;
  }

  // Inline: mdast `image` is phrasing content, so this node sits inside a
  // paragraph alongside text runs (not as its own block).
  isInline(): true {
    return true;
  }

  // Host element carries the exact attribute the context menu targets — kept
  // identical to the old MDXEditor wrapper's image so the menu's `closest()`
  // lookup is unchanged.
  createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.setAttribute("data-editor-block-type", "image");
    span.className = "inline-block align-bottom";
    return span;
  }

  // The node is immutable (fields set once at construction); Lexical re-renders
  // the decorator when needed, so the host never reconciles.
  updateDOM(): false {
    return false;
  }

  decorate(): ReactElement {
    return (
      <ImageComponent
        src={this.__src}
        alt={this.__alt}
        title={this.__title}
        nodeKey={this.getKey()}
      />
    );
  }
}

export function $createImageNode(
  src: string,
  alt: string,
  title: string | null,
): ImageNode {
  return new ImageNode(src, alt, title);
}

export function $isImageNode(
  node: LexicalNode | null | undefined,
): node is ImageNode {
  return node instanceof ImageNode;
}

type LoadState = "loading" | "loaded" | "error";

function ImageComponent({
  src,
  alt,
  title,
  nodeKey,
}: {
  src: string;
  alt: string;
  title: string | null;
  nodeKey: NodeKey;
}) {
  const [editor] = useLexicalComposerContext();
  const { previewHandler } = useContext(ImageHandlersContext);
  const [isSelected, setSelected, clearSelected] =
    useLexicalNodeSelection(nodeKey);

  // The URL actually fed to <img>. null until the (possibly async) resolution
  // lands. `attempt` bumps on a retry to re-run resolution after the backoff.
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve `src` → a loadable URL (via the preview handler, or as-is). Re-runs
  // on each `attempt` so a retry gets a fresh resolution (the attachments query
  // may have caught up in the meantime).
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    const run = async () => {
      try {
        const next = previewHandler ? await previewHandler(src) : src;
        if (!cancelled) setResolvedSrc(next);
      } catch (err) {
        console.error("[ImageNode] preview resolution failed", err);
        if (!cancelled) setState("error");
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [src, previewHandler, attempt]);

  useEffect(() => {
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const onError = useCallback(() => {
    // Post-upload race: an attachments src that resolved to the still-unresolved
    // path 404s; re-resolve a few times before giving up.
    if (src.startsWith("attachments/") && attempt < MAX_RETRIES) {
      retryTimer.current = setTimeout(() => {
        setAttempt((a) => a + 1);
      }, RETRY_DELAY_MS);
      return;
    }
    setState("error");
  }, [src, attempt]);

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      // Node-select the image on click; a NodeSelection lets the default
      // RichText Backspace/Delete (and our explicit handlers below) remove it.
      clearSelected();
      setSelected(true);
    },
    [clearSelected, setSelected],
  );

  // Backspace/Delete on a node-selected image removes it. Lexical 0.35's default
  // RichText handlers don't reliably delete an inline decorator under a
  // NodeSelection, so we wire the standard `$isNodeSelection` pattern explicitly.
  useEffect(() => {
    const onDelete = (event: KeyboardEvent) => {
      if (!isSelected || !$isNodeSelection($getSelection())) return false;
      event.preventDefault();
      const node = $getNodeByKey(nodeKey);
      if ($isImageNode(node)) node.remove();
      return true;
    };
    return mergeRegister(
      editor.registerCommand(
        CLICK_COMMAND,
        (event: MouseEvent) => {
          // Click elsewhere clears our selection (Lexical handles most of this,
          // but keep the ring from lingering when focus moves off the image).
          const el = editor.getElementByKey(nodeKey);
          if (el && event.target instanceof Node && el.contains(event.target)) {
            return false;
          }
          if (isSelected) clearSelected();
          return false;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_DELETE_COMMAND,
        onDelete,
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        onDelete,
        COMMAND_PRIORITY_LOW,
      ),
    );
  }, [editor, isSelected, nodeKey, clearSelected]);

  if (state === "error") {
    return (
      <span
        role="img"
        aria-label={alt || src}
        onClick={onClick}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 align-bottom text-[12px] text-muted-foreground",
          isSelected && "ring-2 ring-ring",
        )}
      >
        <ImageOffIcon className="size-4 shrink-0" />
        <span className="truncate font-mono">{src}</span>
      </span>
    );
  }

  return (
    <span className="inline-block align-bottom">
      {state !== "loaded" && (
        <Skeleton className="inline-block h-40 w-64 max-w-full align-bottom" />
      )}
      {resolvedSrc !== null && (
        <img
          src={resolvedSrc}
          alt={alt}
          title={title ?? undefined}
          draggable={false}
          onClick={onClick}
          onLoad={() => setState("loaded")}
          onError={onError}
          className={cn(
            "max-w-full rounded-md align-bottom",
            state === "loaded" ? "inline-block" : "hidden",
            isSelected && state === "loaded" && "ring-2 ring-ring",
          )}
        />
      )}
    </span>
  );
}
