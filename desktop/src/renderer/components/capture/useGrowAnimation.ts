"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

// The capture→saved grow animation (Todos v1: "pure vertical growth, same
// width/left/top"). FLIP-style on the card element: the caller snapshots the
// pre-transform height with `beginGrow()` right before flipping `stage`; the
// layout effect then pins the card at that height, forces a reflow, animates to
// the new content height (the card has a CSS `transition-[height]`), and
// settles back to `height: auto` so later content changes reflow naturally.
export function useGrowAnimation(
  cardRef: React.RefObject<HTMLDivElement | null>,
  stage: string,
): () => void {
  const prevHeightRef = useRef<number | null>(null);

  const beginGrow = useCallback(() => {
    const el = cardRef.current;
    if (el) prevHeightRef.current = el.getBoundingClientRect().height;
  }, [cardRef]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    const prev = prevHeightRef.current;
    if (!el || prev == null) return;
    prevHeightRef.current = null;
    const target = el.scrollHeight;
    el.style.height = `${prev}px`;
    void el.offsetHeight; // force reflow so the next height starts the transition
    const id = requestAnimationFrame(() => {
      el.style.height = `${target}px`;
    });
    const done = (e: TransitionEvent) => {
      if (e.propertyName !== "height") return;
      el.style.height = "auto";
      el.removeEventListener("transitionend", done);
    };
    el.addEventListener("transitionend", done);
    return () => {
      cancelAnimationFrame(id);
      el.removeEventListener("transitionend", done);
    };
    // Re-runs exactly when the stage flips — that's the FLIP moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  return beginGrow;
}
