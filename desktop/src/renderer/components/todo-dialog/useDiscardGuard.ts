"use client";

// The dismiss state machine for the two-stage todo dialog, factored pure so it's
// unit-testable: saved documents persist on close; capture-stage drafts close
// immediately without a second Escape confirmation.
//
//   saved                → save-and-close  (persist body edits, close)
//   capture              → close           (close instantly)
export type DismissAction = "save-and-close" | "close";

export function dismissAction(args: {
  stage: "capture" | "saved";
}): DismissAction {
  if (args.stage === "saved") return "save-and-close";
  return "close";
}
