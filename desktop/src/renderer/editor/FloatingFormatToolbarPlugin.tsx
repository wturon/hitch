// Selection-driven floating format toolbar for the Hitch editor — the "Notion
// bubble menu". Select a run of text and a compact card floats above it: bold,
// italic, strikethrough, and add-link. It's the inline-formatting counterpart to
// LinkPopoverPlugin, and it deliberately reuses that plugin's hard-won floating
// machinery:
//
//   - portal a plain <div> to document.body, position: fixed from a measured
//     rect, so it stays aligned even when the editor lives inside a centered
//     dialog (the surrounding overlay is irrelevant to where the card lands);
//   - every button preventDefault's its mousedown so the contenteditable never
//     loses focus and the selection never collapses out from under us;
//   - reposition on scroll/resize; close on Escape / outside mousedown.
//
// Why selection-driven off registerUpdateListener (not a DOM selectionchange
// listener): Lexical commits a fresh editor state on every selection move, so we
// read $getSelection() deterministically — and, unlike selectionchange, it's
// reproducible under jsdom (tests drive it with editor.update(() => select())).
//
// One extra wrinkle over the link popover: a text selection is usually made by
// dragging, and showing the toolbar mid-drag (repositioning on every commit as
// the selection grows) is jittery. So we suppress while the pointer is down and
// (re)evaluate on pointerup — the Notion behavior of "appears when you let go".
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  FORMAT_TEXT_COMMAND,
  KEY_ESCAPE_COMMAND,
  type BaseSelection,
  type TextFormatType,
} from "lexical";
import { $isLinkNode, $toggleLink } from "@lexical/link";
import { $findMatchingParent } from "@lexical/utils";
import { BoldIcon, ItalicIcon, LinkIcon, StrikethroughIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { LinkEditForm } from "./LinkPopoverPlugin";
import { spellcheckMenuStore } from "./spellcheckMenuStore";

// A frozen snapshot of the range selection's endpoints. We stash this the moment
// the user opens link-edit mode: focusing the URL input pulls DOM focus out of the
// contenteditable, and Lexical drops its range selection on the next reconcile —
// so we can't rely on $getSelection() being live at save time. Re-materializing
// the range from these points and $setSelection-ing it back makes $toggleLink act
// on exactly the text the user had highlighted.
interface FrozenRange {
  anchorKey: string;
  anchorOffset: number;
  anchorType: "text" | "element";
  focusKey: string;
  focusOffset: number;
  focusType: "text" | "element";
}

// The toolbar's live view of the selection: which inline formats are already on
// (so buttons can show pressed state) and whether the selection sits inside a
// link (so the link button reads as active). Recomputed on every editor commit.
interface FormatState {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  isLink: boolean;
  linkUrl: string | null;
}

function freeze(selection: BaseSelection): FrozenRange | null {
  if (!$isRangeSelection(selection)) return null;
  return {
    anchorKey: selection.anchor.key,
    anchorOffset: selection.anchor.offset,
    anchorType: selection.anchor.type,
    focusKey: selection.focus.key,
    focusOffset: selection.focus.offset,
    focusType: selection.focus.type,
  };
}

// Restore a frozen range as the live editor selection. Called inside an update.
function $thaw(range: FrozenRange): void {
  const selection = $createRangeSelection();
  selection.anchor.set(range.anchorKey, range.anchorOffset, range.anchorType);
  selection.focus.set(range.focusKey, range.focusOffset, range.focusType);
  $setSelection(selection);
}

// Read the inline-format flags + enclosing-link state from the current selection.
// Null when there's nothing worth showing a toolbar for: no range, a collapsed
// caret, or an all-whitespace selection (dragging past a line end shouldn't pop
// the bar).
function $readFormatState(): FormatState | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  if (selection.isCollapsed()) return null;
  if (selection.getTextContent().trim() === "") return null;
  const anchorNode = selection.anchor.getNode();
  const link = $isLinkNode(anchorNode)
    ? anchorNode
    : $findMatchingParent(anchorNode, $isLinkNode);
  return {
    bold: selection.hasFormat("bold"),
    italic: selection.hasFormat("italic"),
    strikethrough: selection.hasFormat("strikethrough"),
    isLink: $isLinkNode(link),
    linkUrl: $isLinkNode(link) ? link.getURL() : null,
  };
}

// The bounding rect of the current DOM selection, or null. This is the anchor the
// card floats above. We read the native selection (which Lexical keeps in lock-step
// with its own) because a range has no single "element" to measure the way a link
// node does. jsdom returns zeros here — tests assert visibility, not coordinates.
function readSelectionRect(): DOMRect | null {
  const domSelection = window.getSelection();
  if (!domSelection || domSelection.rangeCount === 0) return null;
  const range = domSelection.getRangeAt(0);
  // jsdom's Range has no getBoundingClientRect; guard so the plugin still shows
  // (position-less) under test rather than throwing on every selection commit.
  if (typeof range.getBoundingClientRect !== "function") return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0) {
    return null;
  }
  return rect;
}

export function FloatingFormatToolbarPlugin() {
  const [editor] = useLexicalComposerContext();
  const [format, setFormat] = useState<FormatState | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // "edit" swaps the button row for the URL input (add-link mode).
  const [mode, setMode] = useState<"toolbar" | "edit">("toolbar");
  const cardRef = useRef<HTMLDivElement>(null);

  // Yield to the spellcheck context menu: right-clicking a misspelled word both
  // selects it (which would open this toolbar) and raises the spellcheck menu, so
  // without this the two would stack. While that menu is up we render nothing;
  // when it closes we re-appear if the selection is still worth a toolbar.
  const spellcheckOpen = useSyncExternalStore(
    spellcheckMenuStore.subscribe,
    spellcheckMenuStore.isOpen,
  );

  // The selection to re-target when the URL input commits (see FrozenRange).
  const frozenRef = useRef<FrozenRange | null>(null);
  // True while the user is dragging out a selection — suppress the toolbar until
  // they let go, so it doesn't chase the growing selection.
  const selectingRef = useRef(false);
  // Mirror of `mode` for imperative listeners that would otherwise close over a
  // stale value.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const close = useCallback(() => {
    setFormat(null);
    setRect(null);
    setMode("toolbar");
    frozenRef.current = null;
  }, []);

  // Re-read format + rect from the current selection and show/hide accordingly.
  // Kept as one callback so both the update listener and pointerup drive the same
  // path. Never runs while in edit mode (the selection is intentionally frozen).
  const syncFromSelection = useCallback(() => {
    if (modeRef.current === "edit") return;
    if (selectingRef.current) return;
    editor.getEditorState().read(() => {
      const next = $readFormatState();
      if (!next) {
        close();
        return;
      }
      setFormat(next);
      setRect(readSelectionRect());
    });
  }, [editor, close]);

  useEffect(() => {
    return editor.registerUpdateListener(() => syncFromSelection());
  }, [editor, syncFromSelection]);

  // Suppress during drag-select; re-evaluate on release. pointerdown is scoped to
  // the editor root (a drag that starts elsewhere isn't ours); pointerup is on the
  // document because the pointer can leave the root before release.
  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const onDown = () => {
      selectingRef.current = true;
    };
    const onUp = () => {
      if (!selectingRef.current) return;
      selectingRef.current = false;
      // Let the browser settle the selection this pointerup produced before we
      // measure it.
      requestAnimationFrame(() => syncFromSelection());
    };
    root.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerup", onUp);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
    };
  }, [editor, syncFromSelection]);

  // Center the card above the selection rect, 8px gap; clamp horizontally and flip
  // below when it would clip the top of the viewport. Mirrors LinkPopover's
  // fixed-from-measured-rect approach.
  const reposition = useCallback(() => {
    const card = cardRef.current;
    if (!rect || !card) return;
    const cardW = card.offsetWidth;
    const cardH = card.offsetHeight;
    const gap = 8;
    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - cardW / 2, window.innerWidth - cardW - 8),
    );
    let top = rect.top - gap - cardH;
    if (top < 8) top = rect.bottom + gap;
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [rect]);

  useLayoutEffect(() => {
    if (!format) return;
    reposition();
  }, [format, rect, mode, reposition]);

  useEffect(() => {
    if (!format) return;
    const onScroll = () => {
      // In toolbar mode the selection rect is live; refresh it so the card tracks
      // the text as the page scrolls. In edit mode the selection is frozen and the
      // DOM selection is gone (focus is in the input), so keep the last rect.
      if (modeRef.current === "toolbar") setRect(readSelectionRect());
      reposition();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
    };
  }, [format, reposition]);

  // Escape closes the toolbar and consumes the event so the editor's own Escape
  // (blur) and window-level handlers (NotesView exits the note) don't also fire.
  // In edit mode focus is in the input, whose own handler cancels back to toolbar,
  // so this doesn't run there.
  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        if (!format || modeRef.current === "edit") return false;
        event.stopPropagation();
        close();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, format, close]);

  // Close on a mousedown outside both the card and the editor. Clicks inside the
  // editor move the selection (handled by the update listener); card buttons
  // preventDefault their mousedown so they never blur the editor.
  useEffect(() => {
    if (!format) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && cardRef.current?.contains(target)) return;
      const root = editor.getRootElement();
      if (target && root?.contains(target)) return;
      close();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [format, editor, close]);

  const applyFormat = useCallback(
    (type: TextFormatType) => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, type);
    },
    [editor],
  );

  // Enter add-link mode: freeze the current range so we can restore it after the
  // input steals focus, then swap to the URL form.
  const enterLinkEdit = useCallback(() => {
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      frozenRef.current = selection ? freeze(selection) : null;
    });
    setMode("edit");
  }, [editor]);

  const saveLink = useCallback(
    (url: string) => {
      const frozen = frozenRef.current;
      if (url && frozen) {
        editor.update(() => {
          $thaw(frozen);
          $toggleLink(url);
          // Collapse to the end of the freshly-linked run so this toolbar (which
          // only shows for a *range*) closes and LinkPopoverPlugin (which shows for
          // a caret *inside* a link) takes over — a clean hand-off to open/copy/
          // edit the link, rather than two cards stacked over the same selection.
          const sel = $getSelection();
          if ($isRangeSelection(sel)) {
            sel.anchor.set(sel.focus.key, sel.focus.offset, sel.focus.type);
          }
        });
      }
      // Restore focus to the editor; the update listener re-reads the (now
      // collapsed) selection and the link popover picks it up.
      editor.focus();
      close();
    },
    [editor, close],
  );

  const cancelLink = useCallback(() => {
    setMode("toolbar");
    editor.focus();
  }, [editor]);

  if (!format || spellcheckOpen) return null;

  const card =
    mode === "edit" ? (
      <LinkEditForm
        initialUrl={format.linkUrl ?? ""}
        onSave={saveLink}
        onCancel={cancelLink}
      />
    ) : (
      <div
        role="toolbar"
        aria-label="Text formatting"
        className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      >
        <FormatButton
          label="Bold"
          active={format.bold}
          onClick={() => applyFormat("bold")}
        >
          <BoldIcon className="size-4" aria-hidden />
        </FormatButton>
        <FormatButton
          label="Italic"
          active={format.italic}
          onClick={() => applyFormat("italic")}
        >
          <ItalicIcon className="size-4" aria-hidden />
        </FormatButton>
        <FormatButton
          label="Strikethrough"
          active={format.strikethrough}
          onClick={() => applyFormat("strikethrough")}
        >
          <StrikethroughIcon className="size-4" aria-hidden />
        </FormatButton>
        <span className="mx-0.5 my-1 w-px self-stretch bg-border" />
        <FormatButton label="Add link" active={format.isLink} onClick={enterLinkEdit}>
          <LinkIcon className="size-4" aria-hidden />
        </FormatButton>
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

// One toolbar button. mousedown-preventDefault keeps the editor's selection intact
// (the whole point of the floating pattern); `active` shows the pressed state for a
// format already applied to the selection.
function FormatButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
