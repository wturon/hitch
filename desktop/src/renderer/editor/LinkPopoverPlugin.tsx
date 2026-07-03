// Selection-driven link popover for the Hitch editor — the replacement for the
// MDXEditor link dialog. Put the caret inside a link (or select across one) and a
// compact shadcn-style card floats beneath it: open, copy, edit, or unwrap.
//
// Why selection-driven (not a DOM `selectionchange` listener): we read the Lexical
// selection from `registerUpdateListener` + `$getSelection()`. Lexical commits a
// fresh editor state on every selection move, so this fires exactly when the caret
// enters/leaves a link — and, unlike a `selectionchange` DOM listener, it's
// deterministic under jsdom (the tests drive it with `editor.update(() => select())`).
//
// Why we hand-roll the floating div instead of a Radix/Base-UI Popover: those grab
// focus and would collapse the editor selection the moment they mount, closing the
// popover they're supposed to show. Instead we portal a plain <div> to
// document.body, position it with `position: fixed` from the link's own
// getBoundingClientRect(), and make every button `preventDefault` its mousedown so
// the contenteditable never loses focus. Fixed-from-measured-rect is what keeps the
// card aligned to the link even when the editor lives inside a centered dialog (the
// #1 complaint about the old editor) — the surrounding overlay is irrelevant to
// where the card lands.
//
// The ONLY element that legitimately takes focus is the edit-state URL input.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ESCAPE_COMMAND,
  type LexicalNode,
} from "lexical";
import { $isLinkNode, $toggleLink, LinkNode } from "@lexical/link";
import { $findMatchingParent } from "@lexical/utils";
import { CopyIcon, ExternalLinkIcon, PencilIcon, UnlinkIcon } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

// What the popover is bound to. `title` is carried so save can preserve it (the
// bridge round-trips `[text](url "title")` byte-exact and we must never drop it).
interface PopoverState {
  nodeKey: string;
  url: string;
  title: string | null;
  mode: "preview" | "edit";
}

// The link enclosing a node (the node itself, else the nearest link ancestor), or
// null. Used for both the selection anchor and focus so a range selection only
// counts when BOTH ends sit in the same link.
function $nearestLink(node: LexicalNode): LinkNode | null {
  if ($isLinkNode(node)) return node;
  const parent = $findMatchingParent(node, $isLinkNode);
  return $isLinkNode(parent) ? parent : null;
}

// Read (never mutate) the link the current selection lands in. Collapsed caret or
// a range both work; a range that straddles a link boundary returns null.
function $readSelectedLink(): Pick<PopoverState, "nodeKey" | "url" | "title"> | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  const anchorLink = $nearestLink(selection.anchor.getNode());
  if (!anchorLink) return null;
  const focusLink = $nearestLink(selection.focus.getNode());
  if (focusLink !== anchorLink) return null;
  return {
    nodeKey: anchorLink.getKey(),
    url: anchorLink.getURL(),
    title: anchorLink.getTitle() ?? null,
  };
}

// Drop the scheme for the at-rest label (matches the sketch); the real URL is what
// Open/Copy act on and what the edit input shows.
function prettyUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

// The edit-state form. Its own component so the input's draft is local state and
// it re-seeds (autofocus + select) only when it mounts for a given link — keyed by
// nodeKey in the parent. This is the sole element allowed to take focus.
function LinkEditForm({
  initialUrl,
  onSave,
  onCancel,
}: {
  initialUrl: string;
  onSave: (url: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Edit link"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md"
    >
      <div className="flex flex-col gap-1">
        <span className="pl-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
          Link URL
        </span>
        <input
          ref={inputRef}
          type="text"
          spellCheck={false}
          aria-label="Link URL"
          placeholder="Paste or type a URL…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSave(value.trim());
            } else if (e.key === "Escape") {
              // Keep the editor from also handling Escape (blur) and return to
              // preview rather than closing outright.
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          className="h-[30px] w-[280px] max-w-[60vw] rounded-md border border-input bg-background px-2.5 font-mono text-[12.5px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </div>
      <button
        type="button"
        // Keep the input focused / editor selection intact on click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSave(value.trim())}
        className="h-[30px] self-end rounded-md bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
      >
        Save
      </button>
    </div>
  );
}

export function LinkPopoverPlugin() {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<PopoverState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // Mirror of `state` for the imperative listeners (scroll/resize/mousedown/
  // command) that would otherwise close over a stale value.
  const stateRef = useRef<PopoverState | null>(state);
  stateRef.current = state;

  const close = useCallback(() => setState(null), []);

  // Fixed-position the card from the link's live rect: 6px below, left-aligned,
  // clamped horizontally, flipped above when it would clip the viewport bottom.
  const reposition = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;
    const anchorEl = editor.getElementByKey(current.nodeKey);
    const card = cardRef.current;
    if (!anchorEl || !card) return;
    const rect = anchorEl.getBoundingClientRect();
    const cardW = card.offsetWidth;
    const cardH = card.offsetHeight;
    const gap = 6;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - cardW - 8));
    let top = rect.bottom + gap;
    if (top + cardH > window.innerHeight - 8) top = rect.top - gap - cardH;
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [editor]);

  // Open/refresh from the selection. Returning `prev` unchanged when nothing moved
  // avoids a render loop (this runs on every editor commit).
  useEffect(() => {
    return editor.registerUpdateListener(() => {
      editor.getEditorState().read(() => {
        const info = $readSelectedLink();
        setState((prev) => {
          if (!info) return null;
          if (prev && prev.nodeKey === info.nodeKey) {
            if (prev.url === info.url && prev.title === info.title) return prev;
            return { ...prev, url: info.url, title: info.title };
          }
          return { ...info, mode: "preview" };
        });
      });
    });
  }, [editor]);

  // Escape in preview closes the popover AND consumes the event, so the editor's
  // own KEY_ESCAPE (blur) never fires — the caret stays in the link. In edit mode
  // focus is in the input (outside the editor), so this never fires there; the
  // input's own handler returns to preview instead.
  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      () => {
        const current = stateRef.current;
        if (!current || current.mode === "edit") return false;
        close();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, close]);

  // ⌘/Ctrl-click a link in the document opens it directly (Electron's window-open
  // handler routes window.open to shell.openExternal). A plain click just moves the
  // caret, which opens the popover via the selection listener above.
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const anchor = target.closest("a");
      if (!anchor || !root.contains(anchor)) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      window.open(href, "_blank", "noopener");
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [editor]);

  // Mark the anchored link so the user can see what they're acting on; cleaned up
  // when the popover closes or moves to another link.
  useEffect(() => {
    if (!state) return;
    const el = editor.getElementByKey(state.nodeKey);
    if (!el) return;
    el.setAttribute("data-hitch-link-active", "true");
    return () => el.removeAttribute("data-hitch-link-active");
  }, [editor, state?.nodeKey]);

  // Reposition when the card mounts or swaps size (preview ↔ edit), and on
  // scroll/resize while open. useLayoutEffect measures the card before paint so
  // there's no visible jump.
  useLayoutEffect(() => {
    if (!state) return;
    reposition();
  }, [state?.nodeKey, state?.mode, reposition, state]);

  useEffect(() => {
    if (!state) return;
    const onScroll = () => reposition();
    const onResize = () => reposition();
    // Close on a mousedown that's neither inside the card nor inside the editor.
    // (Clicks inside the editor are the selection listener's job; card buttons
    // preventDefault their mousedown, so they never blur the editor anyway.)
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && cardRef.current?.contains(target)) return;
      const root = editor.getRootElement();
      if (target && root?.contains(target)) return;
      close();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [state, editor, reposition, close]);

  const openUrl = useCallback((url: string) => {
    window.open(url, "_blank", "noopener");
  }, []);

  const copyUrl = useCallback((url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => toast.success("Copied link"))
      .catch((err) => console.error("[LinkPopoverPlugin] copy failed", err));
  }, []);

  const enterEdit = useCallback(() => {
    setState((prev) => (prev ? { ...prev, mode: "edit" } : prev));
  }, []);

  // Return to preview and hand focus back to the editor (the Lexical selection was
  // never disturbed, so the caret lands exactly where it was).
  const backToPreview = useCallback(() => {
    setState((prev) => (prev ? { ...prev, mode: "preview" } : prev));
    editor.focus();
  }, [editor]);

  const saveUrl = useCallback(
    (nodeKey: string, newUrl: string) => {
      // Empty input is a no-op cancel — never write an empty href.
      if (!newUrl) {
        backToPreview();
        return;
      }
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        // setURL only — the node's title is left untouched so it round-trips.
        if ($isLinkNode(node)) node.setURL(newUrl);
      });
      backToPreview();
    },
    [editor, backToPreview],
  );

  // Unwrap: select the whole link's text range and toggle the link off, so
  // `[text](url)` becomes `text` with the caret still in the text. The selection
  // now sits outside any link, so the update listener closes the popover.
  const removeLink = useCallback(
    (nodeKey: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        if (!$isLinkNode(node)) return;
        const selection = node.select(0, node.getChildrenSize());
        $setSelection(selection);
        $toggleLink(null);
      });
      editor.focus();
    },
    [editor],
  );

  if (!state) return null;

  const card =
    state.mode === "edit" ? (
      <LinkEditForm
        key={state.nodeKey}
        initialUrl={state.url}
        onSave={(url) => saveUrl(state.nodeKey, url)}
        onCancel={backToPreview}
      />
    ) : (
      <div
        role="dialog"
        aria-label="Link preview"
        className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        <button
          type="button"
          title="Open link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => openUrl(state.url)}
          className="inline-flex max-w-[260px] items-center gap-1.5 overflow-hidden rounded-md px-2 py-1 font-mono text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="truncate">{prettyUrl(state.url)}</span>
          <ExternalLinkIcon className="size-3 shrink-0 opacity-65" aria-hidden />
        </button>
        <span className="mx-0.5 my-1 w-px self-stretch bg-border" />
        <button
          type="button"
          aria-label="Copy link"
          title="Copy link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => copyUrl(state.url)}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <CopyIcon className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Edit link"
          title="Edit link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={enterEdit}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PencilIcon className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Remove link"
          title="Remove link"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => removeLink(state.nodeKey)}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <UnlinkIcon className="size-4" aria-hidden />
        </button>
      </div>
    );

  return createPortal(
    <div
      ref={cardRef}
      className={cn("fixed z-[90]")}
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {card}
    </div>,
    document.body,
  );
}
