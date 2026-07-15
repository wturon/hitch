"use client";

import { useCallback, useMemo } from "react";

import type { TagComboboxOption } from "@/components/tags/TagCombobox";
import type { TagColorName } from "./tagColors";
import {
  ensureRegistryTag,
  registryColorMap,
  serializeTagRegistry,
  type TagRegistry,
} from "./tagRegistry";

// The canonical, headless tag-assignment behavior shared by every surface that
// assigns tags to a task (the todo row's context-menu submenu and the task
// dialog's header lane). It owns the three pieces those surfaces used to each
// re-implement — color lookup, the assign-combobox option union, and the
// toggle/create semantics — so the two surfaces can never drift. Persistence
// stays with the caller (a row writes the file it already holds; the dialog
// writes through its draft): this module decides *what* the next tags/registry
// are, not *how* they land on disk.

// The assign combobox's options: the registry's tags first, then any tag present
// on the task but missing from the registry (so an agent-added, unregistered tag
// can still be toggled off). Deduped by id, registry order preserved.
export function buildAssignOptions(
  registryTagIds: string[],
  presentTags: string[],
  colorOf: (id: string) => TagColorName,
): TagComboboxOption[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of [...registryTagIds, ...presentTags]) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.map((id) => ({ id, color: colorOf(id) }));
}

// The next tag set after toggling `id` on/off (assign if absent, unassign if
// present). Order-preserving; a new tag lands at the end.
export function nextTagsAfterToggle(tags: string[], id: string): string[] {
  return tags.includes(id) ? tags.filter((t) => t !== id) : [...tags, id];
}

// The serialized config.json for registering a brand-new tag's rotation color,
// or null when the id is already registered (nothing to write). Callers persist
// the returned content to TAG_REGISTRY_PATH.
export function newTagRegistryContent(
  registry: TagRegistry,
  id: string,
): string | null {
  const { registry: next, changed } = ensureRegistryTag(registry, id);
  return changed ? serializeTagRegistry(next) : null;
}

// Registry-derived reads shared by both surfaces: the color resolver (gray
// fallback for an unregistered id) and the registry's own tag ids, both
// memoized on the registry. Pair with the pure helpers above for the writes.
export function useTaskTagAssignment(registry: TagRegistry): {
  colorOf: (id: string) => TagColorName;
  registryTagIds: string[];
  buildOptions: (presentTags: string[]) => TagComboboxOption[];
} {
  const colorMap = useMemo(() => registryColorMap(registry), [registry]);
  const colorOf = useCallback(
    (id: string): TagColorName => colorMap.get(id) ?? "gray",
    [colorMap],
  );
  const registryTagIds = useMemo(
    () => registry.tags.map((t) => t.id),
    [registry],
  );
  const buildOptions = useCallback(
    (presentTags: string[]) =>
      buildAssignOptions(registryTagIds, presentTags, colorOf),
    [registryTagIds, colorOf],
  );
  return { colorOf, registryTagIds, buildOptions };
}
