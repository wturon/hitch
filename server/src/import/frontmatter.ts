// THROWAWAY (deleted at M5 with the rest of server/src/import/).
//
// Minimal flat-YAML frontmatter reader, COPIED from the V1 parsers so this
// importer reads task files exactly the way V1 does:
//   - desktop/src/renderer/lib/frontmatter.ts (FRONTMATTER_RE, parseFrontmatter,
//     normalizeTag, parseTagsValue)
// The daemon's daemon/src/frontmatter.ts uses the same regex. Copied (not
// imported) because neither package exports these for server consumption and
// V1 code must not be touched for a throwaway tool.

export interface Frontmatter {
  [key: string]: string;
}

export interface ParsedFile {
  frontmatter: Frontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Split a file into parsed flat frontmatter and its body. The body is the raw
// regex capture — byte-for-byte identical to what V1's editor shows and writes
// back (capture text is sacred: never trimmed, never re-encoded).
export function parseFrontmatter(content: string): ParsedFile {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatter: {}, body: content };

  const [, raw, body] = match;
  const frontmatter: Frontmatter = {};
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    // Strip surrounding quotes from the value.
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

// Normalize one tag token to its canonical id: lowercase kebab.
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Parse a `tags:` frontmatter value (flat, comma-delimited scalar — V1 never
// uses YAML lists) into a normalized, de-duplicated id list, order preserved.
export function parseTagsValue(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = normalizeTag(part);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
