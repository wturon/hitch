"use client";

import { useState } from "react";

// The esc/dismiss state machine for the two-stage todo dialog, factored pure so
// it's unit-testable (Todos v1 Decision 4): stage 1 is transactional (esc can
// destroy), stage 2 is a saved document (esc is free).
//
//   saved                → save-and-close  (persist body edits, close)
//   capture, clean       → close           (nothing exists — close instantly)
//   capture, dirty       → arm             (first esc: destructive footer)
//   capture, dirty+armed → discard         (second esc: close + delete anything
//                                           materialized early)
export type DismissAction = "save-and-close" | "close" | "arm" | "discard";

export function dismissAction(args: {
  stage: "capture" | "saved";
  dirty: boolean;
  armed: boolean;
}): DismissAction {
  if (args.stage === "saved") return "save-and-close";
  if (!args.dirty) return "close";
  return args.armed ? "discard" : "arm";
}

// The armed bit behind the machine. Any typing or click disarms (Decision 4:
// "any typing/click disarms"); only a dismissal arms.
export function useDiscardGuard() {
  const [armed, setArmed] = useState(false);
  return {
    armed,
    arm: () => setArmed(true),
    // Functional no-op when already disarmed, so the capture-phase key/mouse
    // handlers can call this on every event without extra renders.
    disarm: () => setArmed((v) => (v ? false : v)),
  };
}
