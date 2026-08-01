"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

// Raycast-style keyboard navigation for a flat, top-to-bottom list: ↑↓ move a
// highlight, ↵ activates the highlighted row. Shared so the Todos list (and any
// future list) keep ONE source of truth for the fiddly
// parts that otherwise drift between copies — the -1 "nothing highlighted yet"
// sentinel, clamp-in-range, scroll-into-view, the dialog/form-control bailout,
// and the window-level listener that makes the keys work "from anywhere" (not
// just when a row is focused).
//
// The listener lives on `window`, gated on `active`, and is held in a ref so it
// always sees current state without rebinding. View-specific keys (a search
// box's printable filtering, Escape, type-and-enter) stay in the view via the
// `onKeyDown` pre-handler; this hook owns only the generic core.
//
// ONE HIGHLIGHT, ONE RAIL. A row is lit when it is the cursor, and the cursor
// is whichever input device moved last. That is settled in CSS, not in React:
//   • mouse  → the row's own `:hover`
//   • keyboard → the row's own `:focus-visible` (↑↓ carry DOM focus along)
// Both paint the SAME background, so arrowing down the list slides the very
// highlight the mouse leaves behind rather than swapping in a focus ring.
//
// The only thing React can't express in a selector is "which device moved
// last", so this hook writes it onto the container as `data-nav="mouse"|"kbd"`
// and the row suppresses the other device's variant. That write is IMPERATIVE —
// `dataset` on the container node, never state — because it happens on
// mousemove, and re-rendering a list on mousemove is exactly the 8.5ms-per-row
// stall this rail was built to delete. `selected` survives as the LOGICAL
// cursor (what ↵/Backspace/`e` act on, what scroll-into-view chases); it no
// longer paints anything, and the mouse no longer moves it.

export type NavMode = "mouse" | "kbd";

export type ListKeyboardNav = {
  // The highlighted index, or -1 when nothing is highlighted yet.
  selected: number;
  setSelected: (next: number | ((prev: number) => number)) => void;
  // Spread onto each navigable row's root. `i` is the row's index in the same
  // flat order the hook navigates. Supplies the data-idx used by
  // scroll-into-view and the aria-selected state — and nothing else. There is
  // deliberately no mouse handler here: hover is the row's own CSS.
  itemProps: (i: number) => {
    "data-idx": number;
    "aria-selected": boolean;
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
  // -1 = "the keyboard has no row yet": ↵/Backspace/`e` do nothing until the
  // user actually arrows or tabs to one (a view that wants type-and-enter
  // handles ↵ itself via onKeyDown while selected is -1). Hovering does NOT
  // arm it — pointing at a row is not the same as choosing it, and the old
  // hover-arming is what let a stray Backspace delete whatever you happened to
  // be pointing at.
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

  // Which device owns the highlight right now, written straight to the DOM.
  // Nothing here calls setState: the mousemove path must stay free.
  const setMode = (mode: NavMode) => {
    const el = containerRef.current;
    if (el && el.dataset.nav !== mode) el.dataset.nav = mode;
  };

  // Hand the highlight back to the mouse the moment it moves. On `window`, not
  // on the container, for the same reason the keydown listener is: a view
  // early-returns "Loading…" on its first render, so the container ref is still
  // null when effects run and a listener bound to `containerRef.current` here
  // would attach to nothing and never retry. Resolving the ref INSIDE the
  // handler sidesteps that — by the time a mouse moves, the list is mounted.
  //
  // Cost per event is one ref read and one string compare; the DOM is touched
  // only on an actual mouse→keyboard→mouse flip, so sweeping 60 rows does no
  // work at all.
  useEffect(() => {
    if (!active) return;
    const onMouseMove = () => setMode("mouse");
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, [active]);

  // Focus IS the cursor, so anything that lands focus on a row adopts that row:
  // Tab, a click, and the ↑↓ focus-move. Without this the highlight you can SEE
  // (focus) and the row ↵/Backspace/`e` act on could be different rows.
  //
  // Bound to `window` for the same reason as the two above — a view that
  // early-returns "Loading…" has a null container ref when effects first run,
  // and this listener used to be bound to `containerRef.current` inside each
  // view, so it silently attached to nothing and never retried. Hover-arming
  // hid that; with hover no longer arming anything, it is load-bearing.
  useEffect(() => {
    if (!active) return;
    const onFocusIn = (e: FocusEvent) => {
      const el = containerRef.current;
      const target = e.target as HTMLElement | null;
      if (!el || !target || !el.contains(target)) return;
      const row = target.closest<HTMLElement>("[data-idx]");
      if (!row) return;
      const i = Number(row.dataset.idx);
      if (Number.isInteger(i)) setSelected(i);
    };
    window.addEventListener("focusin", onFocusIn);
    return () => window.removeEventListener("focusin", onFocusIn);
  }, [active, containerRef]);

  // Held in a ref so the window listener always sees current props/state without
  // re-binding on every render.
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {});
  handlerRef.current = (e) => {
    if (e.defaultPrevented) return;
    if (ignoreTarget(e.target as HTMLElement | null)) return;
    // Hand the highlight to the keyboard on any key that can MOVE it — before
    // `onKeyDown`, so a view that claims ↑↓ for itself still flips the mode.
    // Tab counts: it lands focus on a row, and a row that has keyboard focus
    // has to look like it.
    if (e.key.startsWith("Arrow") || e.key === "Tab") setMode("kbd");
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
  });

  return { selected, setSelected, itemProps };
}
