import type { Id } from "@convex/_generated/dataModel";

// Capture-stage draft recovery (Todos v1 Decision 4 amendment): esc in capture
// now ALWAYS closes instantly (no armed/double-esc guard), so a typed-but-
// unsaved capture would silently vanish. Instead, the typed text is stashed in
// localStorage per project and restored the next time capture opens, so an
// accidental dismiss (esc, outside click) is recoverable. Cleared on a
// successful ⌘⏎ save, or whenever the capture is empty.
//
// Factored pure (no React) so it's unit-testable without mounting the dialog.
const DRAFT_KEY_PREFIX = "hitch:todo-capture-draft:";

function draftKey(projectId: Id<"projects">): string {
  return `${DRAFT_KEY_PREFIX}${projectId}`;
}

export function loadCaptureDraft(projectId: Id<"projects">): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(draftKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { content?: unknown };
    return typeof parsed.content === "string" ? parsed.content : null;
  } catch {
    return null;
  }
}

// Persists `content` as the recovery draft, or clears it when empty (an empty
// capture has nothing worth recovering).
export function saveCaptureDraft(projectId: Id<"projects">, content: string): void {
  if (typeof window === "undefined") return;
  try {
    if (content.trim() === "") {
      window.localStorage.removeItem(draftKey(projectId));
      return;
    }
    window.localStorage.setItem(
      draftKey(projectId),
      JSON.stringify({ content, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // localStorage can be unavailable or full; losing the recovery draft
    // should not block normal capture close.
  }
}

export function clearCaptureDraft(projectId: Id<"projects">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftKey(projectId));
  } catch {
    // Ignore storage failures.
  }
}
