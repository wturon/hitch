// Which sections are collapsed, per project.
//
// Deliberately NOT server state. Collapsing is a view preference about how much
// of a list you want to see on the screen in front of you — it isn't structure,
// it doesn't belong to the project, and syncing it would mean one machine
// folding a section closed on another. Same reasoning, same storage shape and
// same failure behavior as the tag filter (tagFilter.ts): a corrupt or absent
// value degrades to "nothing collapsed" rather than blocking a render.

const COLLAPSE_KEY_PREFIX = "hitch:v2:collapsed-sections:";

function collapseKey(projectId: string): string {
  return `${COLLAPSE_KEY_PREFIX}${projectId}`;
}

export function loadCollapsedSections(projectId: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(collapseKey(projectId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function saveCollapsedSections(projectId: string, ids: ReadonlySet<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(collapseKey(projectId));
      return;
    }
    window.localStorage.setItem(collapseKey(projectId), JSON.stringify([...ids]));
  } catch {
    // localStorage can be unavailable or full; losing the collapse state should
    // never block rendering the list.
  }
}
