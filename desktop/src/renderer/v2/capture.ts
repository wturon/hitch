import { generateKeyBetween } from "fractional-indexing";

// Pure capture helpers for TaskDialogV2 (M2 PR 3). No React, no HTTP —
// unit-testable in isolation.
//
// The capture invariant (Will's rule, carried verbatim from V1): capture text
// is sacred — the typed text becomes the task BODY verbatim (only CRLFs
// normalized so pasted markdown round-trips); the title is additive metadata
// derived from the body, never carved out of it. LLM auto-title is DROPPED in
// V2 (adopted decision, M2 plan) — the seed title is the title.

// Normalize line endings only. Anything beyond this would violate
// body-verbatim; the server's PATCH/POST also passes the body through
// untouched (routes/tasks.ts).
export function normalizeCaptureBody(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Fall back to the first line of the body when a task is captured without a
// title: the first ~6 words of the first non-empty line, with the most common
// inline/leading markdown stripped so the title reads as plain prose. Returns
// "" when the body has no words, so the caller can substitute a default.
export function deriveTitleFromBody(body: string, maxWords = 6): string {
  const firstLine =
    body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, "") // heading markers
    .replace(/^>\s+/, "") // blockquote
    .replace(/^[-*+]\s+/, "") // bullet
    .replace(/^\d+\.\s+/, "") // ordered-list marker
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/[*_`~]/g, "") // emphasis / code / strike marks
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").filter(Boolean).slice(0, maxWords).join(" ");
}

// The seed title: the body's first ~6 words with leading/inline markdown
// stripped. Falls back to "Untitled" when the body has no words (e.g. symbols
// only): the server requires a non-empty title, and "Untitled" is what the
// dialog header shows for an empty one anyway.
export function captureSeedTitle(body: string): string {
  return deriveTitleFromBody(body) || "Untitled";
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
