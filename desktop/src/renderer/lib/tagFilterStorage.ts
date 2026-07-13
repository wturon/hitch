import type { Id } from "@convex/_generated/dataModel";
import { EMPTY_TAG_FILTER, type TagFilter } from "./todos";

// The tag filter is view-local UI state (Todos 2.0 tagging v1): persisted per
// project in localStorage — same pattern as the capture draft — never in Convex
// or files. Restored when you return to the project, cleared with "Clear". A
// bad/absent value degrades to the empty (inactive) filter.
const FILTER_KEY_PREFIX = "hitch:todo-tag-filter:";

function filterKey(projectId: Id<"projects">): string {
  return `${FILTER_KEY_PREFIX}${projectId}`;
}

export function loadTagFilter(projectId: Id<"projects">): TagFilter {
  if (typeof window === "undefined") return EMPTY_TAG_FILTER;
  try {
    const raw = window.localStorage.getItem(filterKey(projectId));
    if (!raw) return EMPTY_TAG_FILTER;
    const parsed = JSON.parse(raw) as { tags?: unknown; untagged?: unknown };
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string")
      : [];
    const untagged = parsed.untagged === true;
    // Enforce the exclusivity invariant on read, in case a hand-edited value
    // violates it.
    if (untagged) return { tags: [], untagged: true };
    return { tags, untagged: false };
  } catch {
    return EMPTY_TAG_FILTER;
  }
}

export function saveTagFilter(
  projectId: Id<"projects">,
  filter: TagFilter,
): void {
  if (typeof window === "undefined") return;
  try {
    if (!filter.untagged && filter.tags.length === 0) {
      window.localStorage.removeItem(filterKey(projectId));
      return;
    }
    window.localStorage.setItem(filterKey(projectId), JSON.stringify(filter));
  } catch {
    // localStorage can be unavailable or full; losing the persisted filter
    // should never block rendering the list.
  }
}
