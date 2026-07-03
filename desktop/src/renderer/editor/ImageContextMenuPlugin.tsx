// Right-click menu for an inline image: Copy Image / Delete. Ported almost
// verbatim from the old MDXEditor wrapper (components/MarkdownEditor.tsx), adapted
// to our own ImageNode and re-skinned to use the app's sonner toast wrapper for
// feedback instead of the wrapper's hand-rolled fixed-position status div.
//
// It's mounted unconditionally by MarkdownEditor — inert until a right-click
// actually lands on an image node's host span (the `data-editor-block-type=
// "image"` element createDOM stamps). The preview handler (for resolving an
// attachments src before fetching its bytes) comes from ImageHandlersContext, so
// the plugin needs no props.
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNodeByKey, $nodesOfType, type NodeKey } from "lexical";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { ImageNode, ImageHandlersContext } from "./nodes/ImageNode";

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

// Resolve the src (via the preview handler if present), fetch its bytes, and
// write them to the clipboard as a real image. If the fetch/clipboard path fails
// but the daemon exposes a native fallback, hand it the resolved URL.
async function copyImageToClipboard(
  src: string,
  previewHandler: ((src: string) => Promise<string>) | undefined,
) {
  const resolvedSrc = previewHandler ? await previewHandler(src) : src;
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

export function ImageContextMenuPlugin() {
  const [editor] = useLexicalComposerContext();
  const { previewHandler } = useContext(ImageHandlersContext);
  const [menu, setMenu] = useState<ImageContextMenuState | null>(null);

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
      setMenu(nextMenu);
    };

    root.addEventListener("contextmenu", onContextMenu, true);
    return () => root.removeEventListener("contextmenu", onContextMenu, true);
  }, [editor]);

  const copyImage = useCallback(() => {
    if (!menu) return;
    const src = menu.src;
    closeMenu();
    void copyImageToClipboard(src, previewHandler)
      .then(() => toast.success("Image copied"))
      .catch((err) => {
        console.error("Image copy failed", err);
        toast.error("Could not copy image");
      });
  }, [closeMenu, previewHandler, menu]);

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
        DOMRect.fromRect({ x: menu.x, y: menu.y, width: 0, height: 0 }),
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
    </ContextMenu>
  );
}
