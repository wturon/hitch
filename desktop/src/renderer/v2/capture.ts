import { generateKeyBetween } from "fractional-indexing";

// Pure capture helpers for TaskDialogV2 (M2 PR 3). No React, no HTTP —
// unit-testable in isolation.
//
// The capture invariant (Will's rule, carried verbatim from V1): capture text
// is sacred — the typed text becomes the task BODY verbatim (only CRLFs
// normalized so pasted markdown round-trips); the title is additive metadata
// derived from the body, never carved out of it. The seed is immediately
// usable while the daemon improves it asynchronously.

// Normalize line endings only. Anything beyond this would violate
// body-verbatim; the server's PATCH/POST also passes the body through
// untouched (routes/tasks.ts).
export function normalizeCaptureBody(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// The sortOrder for a captured task: a fractional-index key BEFORE the current
// backlog head, so new items land at the top (V1's prepend-on-save decision).
// `backlog` is the open group in list order (sortOrder ascending) — pass
// deriveTaskGroups(...).backlog. Empty backlog → the first key.
export function captureSortOrder(
  backlog: ReadonlyArray<{ sortOrder: string }>,
): string {
  return generateKeyBetween(null, backlog[0]?.sortOrder ?? null);
}
