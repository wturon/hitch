// Our own spellcheck context menu, replacing the native OS menu. Chromium's
// spellchecker is the only source of per-word suggestions, and it only surfaces
// them through the main process `context-menu` event — so the main process pulls
// `misspelledWord` + `dictionarySuggestions` off that event and pushes them here
// over IPC (window.hitchDaemon.onSpellcheckMenu). We then draw an app-styled menu
// at the click point instead of popping the native one, which is what stopped the
// two-menus-at-once problem: a native menu we couldn't style sitting next to the
// editor's floating format toolbar.
//
// Mounted once at the app root (AppRoot) so it covers every editable surface the
// OS spellchecks — the task title input, the composer, and the Lexical body —
// not just the rich-text editor. While it's open it sets a shared flag
// (spellcheckMenuStore) that the format toolbar reads to hide itself, so exactly
// one menu shows per right-click.
//
// Applying a fix rides Chromium's own machinery: replaceMisspelling replaces the
// word the spellchecker currently has selected (the context-menu event selected
// it), and addWordToSpellCheckerDictionary teaches the dictionary. Both go back
// through IPC to the focused webContents. Every button preventDefaults its
// mousedown so the editable never blurs and that selection stays put.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { spellcheckMenuStore } from "@/editor/spellcheckMenuStore";

// The payload the main process sends on a right-click over a misspelled word.
// x/y are the viewport click coordinates (params.x / params.y).
export interface SpellcheckMenuPayload {
  word: string;
  suggestions: string[];
  x: number;
  y: number;
}

// The slice of the preload bridge this component needs. window.hitchDaemon is the
// full API; we cast to just these three so the component doesn't depend on the
// whole interface (matching how other components narrow the bridge).
interface SpellcheckBridge {
  replaceMisspelling: (word: string) => Promise<void>;
  addWordToDictionary: (word: string) => Promise<void>;
  onSpellcheckMenu: (
    callback: (payload: SpellcheckMenuPayload) => void,
  ) => () => void;
}

function getBridge(): SpellcheckBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { hitchDaemon?: SpellcheckBridge }).hitchDaemon;
}

export function SpellcheckMenu() {
  const [payload, setPayload] = useState<SpellcheckMenuPayload | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setPayload(null);
    setPos(null);
    spellcheckMenuStore.setOpen(false);
  }, []);

  // Subscribe to the main-process push. Each new right-click replaces any open
  // menu; the store flag flips on so the format toolbar yields immediately.
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    return bridge.onSpellcheckMenu((next) => {
      setPayload(next);
      spellcheckMenuStore.setOpen(true);
    });
  }, []);

  // Anchor the menu's top-left to the click point, then nudge it back inside the
  // viewport if it would overflow the right/bottom edge. Measured after mount so
  // we know the real menu size.
  useLayoutEffect(() => {
    if (!payload) return;
    const menu = menuRef.current;
    if (!menu) return;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const left = Math.min(payload.x, window.innerWidth - w - 8);
    const top = Math.min(payload.y, window.innerHeight - h - 8);
    setPos({ left: Math.max(8, Math.round(left)), top: Math.max(8, Math.round(top)) });
  }, [payload]);

  // Dismiss on outside mousedown, Escape, scroll, or resize — the usual context-
  // menu affordances. Capture-phase mousedown so we see it before anything else.
  useEffect(() => {
    if (!payload) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [payload, close]);

  const replace = useCallback(
    (suggestion: string) => {
      void getBridge()?.replaceMisspelling(suggestion);
      close();
    },
    [close],
  );

  const addToDictionary = useCallback(() => {
    if (payload) void getBridge()?.addWordToDictionary(payload.word);
    close();
  }, [payload, close]);

  if (!payload) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Spelling suggestions"
      className="fixed z-[100] min-w-[200px] max-w-[280px] overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-md"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <div className="px-3 pb-1 pt-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
        Suggestions
      </div>
      {payload.suggestions.length > 0 ? (
        payload.suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => replace(suggestion)}
            className="flex w-full items-center px-3 py-1 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
          >
            {suggestion}
          </button>
        ))
      ) : (
        <div className="px-3 py-1 text-[13px] italic text-muted-foreground">
          No suggestions
        </div>
      )}
      <div className="my-1 h-px bg-border" />
      <button
        type="button"
        role="menuitem"
        onMouseDown={(e) => e.preventDefault()}
        onClick={addToDictionary}
        className="flex w-full items-center px-3 py-1 text-left text-[13px] text-foreground outline-none hover:bg-accent focus-visible:bg-accent"
      >
        Add to Dictionary
      </button>
    </div>,
    document.body,
  );
}
