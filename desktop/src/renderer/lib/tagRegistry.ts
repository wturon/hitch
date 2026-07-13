// The tag color registry: a single synced file, `tasks/config.json`, mapping
// tag ids to named colors. It is ADVISORY and colors-only — the task frontmatter
// (`tags:`) is the source of truth for *which* tags a task has. A tag that
// appears on a task but not here simply renders gray (see tagColors). Agents can
// assign tags by editing `tags:` directly without ever touching this file.
//
// The renderer already subscribes to every project file, so the registry is read
// out of that existing `files` query (never fetched separately) and written back
// through the same optimistic file-upsert path as task bodies. It never appears
// as a task: `taskSlug` only matches `tasks/<slug>/task.md`, so `tasks/config.json`
// is naturally excluded from the todo derivation.

import { nextRotationColor, toTagColor, type TagColorName } from "./tagColors";
import { normalizeTag } from "./frontmatter";

// The synced path (relative to the project's .hitch root), and the fabricated
// path the daemon syncs like any other file under tasks/.
export const TAG_REGISTRY_PATH = "tasks/config.json";

export interface RegistryTag {
  id: string;
  color: TagColorName;
}

export interface TagRegistry {
  version: number;
  tags: RegistryTag[];
}

export const EMPTY_REGISTRY: TagRegistry = { version: 1, tags: [] };

// Parse the registry file tolerantly: malformed JSON, missing keys, unknown
// colors, and duplicate/blank ids all degrade to something sane rather than
// throwing (the registry is never allowed to be an error surface). Ids are
// normalized so they line up with frontmatter tag ids; unknown colors clamp to
// gray; the first occurrence of a duplicate id wins.
export function parseTagRegistry(content: string | undefined): TagRegistry {
  if (!content || content.trim() === "") return { ...EMPTY_REGISTRY, tags: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { ...EMPTY_REGISTRY, tags: [] };
  }
  const obj = (raw ?? {}) as { version?: unknown; tags?: unknown };
  const version = typeof obj.version === "number" ? obj.version : 1;
  const tags: RegistryTag[] = [];
  const seen = new Set<string>();
  if (Array.isArray(obj.tags)) {
    for (const entry of obj.tags) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as { id?: unknown; color?: unknown };
      const id = typeof e.id === "string" ? normalizeTag(e.id) : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      tags.push({
        id,
        color: toTagColor(typeof e.color === "string" ? e.color : undefined),
      });
    }
  }
  return { version, tags };
}

// A quick id → color lookup for rendering pills.
export function registryColorMap(
  registry: TagRegistry,
): Map<string, TagColorName> {
  return new Map(registry.tags.map((t) => [t.id, t.color]));
}

// Serialize back to a pretty-printed JSON string (trailing newline) so the file
// stays hand-editable and diffs cleanly.
export function serializeTagRegistry(registry: TagRegistry): string {
  return `${JSON.stringify(
    { version: registry.version, tags: registry.tags },
    null,
    2,
  )}\n`;
}

// Ensure `id` exists in the registry, appending it with the next rotation color
// if absent (Notion behavior). Returns the SAME registry object when the id is
// already present, so callers can skip the file write on a no-op. `id` is
// normalized; a blank id is a no-op.
export function ensureRegistryTag(
  registry: TagRegistry,
  id: string,
): { registry: TagRegistry; changed: boolean } {
  const normalized = normalizeTag(id);
  if (!normalized || registry.tags.some((t) => t.id === normalized)) {
    return { registry, changed: false };
  }
  return {
    registry: {
      version: registry.version,
      tags: [
        ...registry.tags,
        { id: normalized, color: nextRotationColor(registry.tags.length) },
      ],
    },
    changed: true,
  };
}
