// The tag-filter primitive: an AND-selected set of tag ids plus an exclusive
// "untagged" mode. Kept small and row-model-agnostic so both the shared tag UI
// (components/tags) and the V2 task views can import it without pulling in any
// task-derivation code. The actual matching over a concrete row model lives with
// that model (see v2/tagFilter.ts), which reuses these primitives.
//
// AND semantics: a row matches only if it carries EVERY selected tag. `untagged`
// is exclusive — it matches rows with zero tags and can never co-exist with tag
// selections (untagged ∧ tag is always empty).

export interface TagFilter {
  tags: string[]; // AND-selected tag ids
  untagged: boolean; // exclusive with `tags`
}

export const EMPTY_TAG_FILTER: TagFilter = { tags: [], untagged: false };

export function isTagFilterActive(f: TagFilter): boolean {
  return f.untagged || f.tags.length > 0;
}
