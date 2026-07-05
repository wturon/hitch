"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// Raycast-style keyboard navigation for a flat, top-to-bottom list: ↑↓ move a
// highlight, ↵ activates the highlighted row. Extracted from the Notes index so
// the Todos list (and any future list) share ONE source of truth for the fiddly
// parts that otherwise drift between copies — the -1 "nothing highlighted yet"
// sentinel, clamp-in-range, scroll-into-view, the dialog/form-control bailout,
// and the window-level listener that makes the keys work "from anywhere" (not
// just when a row is focused).
//
// The listener lives on `window`, gated on `active`, and is held in a ref so it
// always sees current state without rebinding. View-specific keys (a search
// box's printable filtering, Escape, type-and-enter) stay in the view via the
// `onKeyDown` pre-handler; this hook owns only the generic core.

export type ListKeyboardNav = {
  // The highlighted index, or -1 when nothing is highlighted yet.
  selected: number;
  setSelected: (next: number | ((prev: number) => number)) => void;
  // Spread onto each navigable row's root. `i` is the row's index in the same
  // flat order the hook navigates. Supplies the data-idx used by scroll-into-view,
  // the aria-selected state, and hover-to-highlight so mouse and keyboard share
  // one selection.
  itemProps: (i: number) => {
    "data-idx": number;
    "aria-selected": boolean;
    onMouseMove: () => void;
  };
};

// The default target guard: defer only where ↑↓/↵ already mean something —
// inside an open overlay (it owns its keys) or a text-entry field (caret /
// submit). Plain buttons, links and `role="button"` rows are NOT deferred to:
// arrows are meaningless on them, so nav keeps working "from anywhere" even when
// stray focus lands on a button (e.g. a dialog restoring focus to its trigger).
// The Enter handler's preventDefault then also suppresses that button's activation.
function defaultIgnoreTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (
    target.closest(
      '[role="dialog"],[role="alertdialog"],[role="menu"]',
    )
  ) {
    return true;
  }
  return Boolean(
    target.closest('input,textarea,select,[contenteditable="true"]'),
  );
}

export function useListKeyboardNav({
  count,
  active,
  containerRef,
  onActivate,
  ignoreTarget = defaultIgnoreTarget,
  onKeyDown,
}: {
  // Number of navigable rows, in the same order as `itemProps` indices.
  count: number;
  // Attach the listener only while the list is the live surface (e.g. no dialog
  // open over it). Detaches on false.
  active: boolean;
  // The scroll container holding the rows; scroll-into-view queries `data-idx`
  // within it.
  containerRef: RefObject<HTMLElement | null>;
  // ↵ on the highlighted row. Receives its index.
  onActivate: (index: number) => void;
  // Override the "should I ignore this event's target?" guard (e.g. a search
  // input that IS part of the list nav). Defaults to dialog/menu/form-control.
  ignoreTarget?: (target: HTMLElement | null) => boolean;
  // View-specific keys, run after the target guard and before ↑↓/↵. Return true
  // to claim the event (the hook then does nothing more with it).
  onKeyDown?: (
    e: KeyboardEvent,
    ctx: { selected: number; setSelected: ListKeyboardNav["setSelected"] },
  ) => boolean;
}): ListKeyboardNav {
  // -1 = "no row highlighted yet": rows stay uniform until the user arrows (or
  // hovers), and ↵ does nothing (a view that wants type-and-enter handles ↵
  // itself via onKeyDown while selected is -1).
  const [selected, setSelected] = useState(-1);

  // Keep the selection in range as the list changes; a -1 is preserved.
  useEffect(() => {
    setSelected((i) => Math.min(i, count - 1));
  }, [count]);

  // Keep the highlighted row in view during keyboard navigation.
  useEffect(() => {
    if (selected < 0) return;
    containerRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, containerRef]);

  // Held in a ref so the window listener always sees current props/state without
  // re-binding on every render.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handlerRef.current = (e) => {
    if (e.defaultPrevented) return;
    if (ignoreTarget(e.target as HTMLElement | null)) return;
    if (onKeyDown?.(e, { selected, setSelected })) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (count) setSelected((i) => (i < 0 ? 0 : Math.min(i + 1, count - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (count) setSelected((i) => (i < 0 ? count - 1 : Math.max(i - 1, 0)));
    } else if (e.key === "Enter") {
      if (selected < 0) return;
      e.preventDefault();
      onActivate(selected);
    }
  };

  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => handlerRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [active]);

  const itemProps = (i: number) => ({
    "data-idx": i,
    "aria-selected": i === selected,
    onMouseMove: () => setSelected(i),
  });

  return { selected, setSelected, itemProps };
}
