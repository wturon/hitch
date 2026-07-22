// V2 tag filtering (M2 PR 5). The server-rows successor to lib/todos.ts's
// filter section + lib/tagFilterStorage: same AND semantics, same exclusive
// Untagged, same per-project localStorage persistence — but operating on the
// tag NAMES resolved from a task's `tagIds` instead of frontmatter tag ids.
// Names are the client-side tag identity throughout V2's UI (the server
// enforces name-unique-per-user, so name ↔ uuid is a bijection): that is what
// lets TagCombobox/TagFilterBar/TagPill — which all render their option `id`
// as the visible label — be imported from V1 unchanged. The uuid appears only
// at the HTTP boundary (useTagMutations).
//
// The filter TYPE and its active-check are V1's own, imported — they are pure
// shape (`{ tags: string[]; untagged: boolean }`), nothing V1-specific. The
// match/facet/storage functions are siblinged: V1's are welded to the `Todo`
// row shape and the Convex `Id<"projects">` brand.

import { EMPTY_TAG_FILTER, isTagFilterActive, type TagFilter } from "@/lib/todos";
import type { TaskGroups, TaskRow } from "./todoGroups";

export { EMPTY_TAG_FILTER, isTagFilterActive, type TagFilter };

// AND semantics: a task matches only if it carries EVERY selected tag.
// `untagged` is exclusive — it matches tasks with zero tags and never
// co-exists with tag selections (untagged ∧ tag is always empty).
export function taskMatchesTagFilter(tagNames: string[], f: TagFilter): boolean {
  if (f.untagged) return tagNames.length === 0;
  if (f.tags.length === 0) return true;
  return f.tags.every((t) => tagNames.includes(t));
}

// Project the grouped rows through the active filter. Inactive filter → the
// groups pass through unchanged (same object). Non-matching rows drop out,
// which naturally empties groups the view then hides entirely.
export function filterTaskGroups<T extends TaskRow>(
  groups: TaskGroups<T>,
  f: TagFilter,
  namesOf: (task: T) => string[],
): TaskGroups<T> {
  if (!isTagFilterActive(f)) return groups;
  const keep = (list: T[]) => list.filter((t) => taskMatchesTagFilter(namesOf(t), f));
  return {
    needsYou: keep(groups.needsYou),
    working: keep(groups.working),
    backlog: keep(groups.backlog),
    done: keep(groups.done),
  };
}

// Facet counts for the filter popover — V1's tagFacetCounts ported onto
// per-task tag-name lists. For each tag: how many tasks WOULD match if that
// tag were added to the current selection (checked tags show the current
// match count, since re-adding a selected tag is a no-op). `untagged` is the
// count of tasks with zero tags. A tag no task carries isn't in `byTag` —
// callers default it to 0. When the filter is currently on Untagged, counts
// are computed against a cleared base so the tag rows preview "switch to
// this tag".
export function tagFacetCounts(
  taskTagNames: string[][],
  f: TagFilter,
): { byTag: Map<string, number>; untagged: number } {
  const base: TagFilter = f.untagged ? EMPTY_TAG_FILTER : f;
  const byTag = new Map<string, number>();
  const universe = new Set<string>();
  for (const names of taskTagNames) for (const name of names) universe.add(name);
  for (const name of universe) {
    const probe: TagFilter = base.tags.includes(name)
      ? base
      : { tags: [...base.tags, name], untagged: false };
    byTag.set(
      name,
      taskTagNames.filter((names) => taskMatchesTagFilter(names, probe)).length,
    );
  }
  return {
    byTag,
    untagged: taskTagNames.filter((names) => names.length === 0).length,
  };
}

// --- Persistence (per project, localStorage — never on the server) ----------
// V1's tagFilterStorage pattern under a v2-namespaced key (V2 project ids are
// server uuids, a different id universe from V1's Convex ids). A bad/absent
// value degrades to the empty (inactive) filter.
const FILTER_KEY_PREFIX = "hitch:v2:todo-tag-filter:";

function filterKey(projectId: string): string {
  return `${FILTER_KEY_PREFIX}${projectId}`;
}

export function loadTagFilter(projectId: string): TagFilter {
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

export function saveTagFilter(projectId: string, filter: TagFilter): void {
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
