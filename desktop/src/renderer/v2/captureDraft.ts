// Capture-stage draft recovery for the V2 dialog — a SIBLING of V1's
// components/todo-dialog/captureDraft.ts, not an import: that module's
// signature is welded to the Convex `Id<"projects">` brand, and the v2/ tree
// stays Convex-free (the whole dep leaves at M5). Same UX contract: esc in
// capture closes instantly, so the typed text is stashed per project and
// restored the next time capture opens; cleared on a successful ⌘⏎ save, or
// whenever the capture is empty.
//
// Factored pure (no React) so it's unit-testable without mounting the dialog.
// The key prefix is V2's own — server project uuids and Convex ids live in
// disjoint namespaces, but a shared prefix would still be a lie.
const DRAFT_KEY_PREFIX = "hitch:v2:capture-draft:";

function draftKey(projectId: string): string {
  return `${DRAFT_KEY_PREFIX}${projectId}`;
}

export function loadCaptureDraft(projectId: string): string | null {
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
export function saveCaptureDraft(projectId: string, content: string): void {
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

export function clearCaptureDraft(projectId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftKey(projectId));
  } catch {
    // Ignore storage failures.
  }
}
