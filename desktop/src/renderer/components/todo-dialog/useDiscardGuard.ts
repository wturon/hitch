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

// Whether a save-and-close must actually write. Two gates, OR'd:
//   • `latest !== lastWritten` — ordinary edits since OUR last write.
//   • `dirty` (draft ≠ the LIVE row) — the claimed-title race. After the user
//     focuses the title input, the daemon's generated title lands on disk while
//     the claimed merge keeps the draft byte-identical to our last write (the
//     seed). Comparing only against lastWritten skips that write, so the
//     forfeited generation would survive on disk and reappear on reopen.
// A redundant write (both gates true for the same edit) is a harmless
// idempotent upsert; a skipped necessary one loses the claim. Prefer writing.
export function shouldSaveOnClose(args: {
  dirty: boolean;
  latest: string;
  lastWritten: string | null;
}): boolean {
  return args.dirty || args.latest !== args.lastWritten;
}
