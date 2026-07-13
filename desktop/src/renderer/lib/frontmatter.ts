// Minimal YAML-frontmatter reader. The board only needs a few scalar fields
// (status, owner, title) for now, so we avoid pulling in a YAML dependency.
// Swap in gray-matter / yaml later if files grow richer frontmatter.

export interface Frontmatter {
  [key: string]: string;
}

export interface ParsedFile {
  frontmatter: Frontmatter;
  body: string;
}

export interface SplitFile {
  // The literal `---\n…\n---\n` prefix, byte-for-byte (empty when the file has
  // no frontmatter). Kept verbatim — never re-serialized from the parsed object.
  frontmatterBlock: string;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Split a file into its raw frontmatter block and body without round-tripping
// the YAML. The friendly editor only ever sees `body`; on save we recombine
// `frontmatterBlock + body`, so Hitch's machinery (chat-*, status, title…) is
// preserved exactly. Deriving the block as `content` minus the body suffix keeps
// it byte-identical to the original, including spacing and quoting.
export function splitFrontmatter(content: string): SplitFile {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { frontmatterBlock: "", body: content };
  const body = match[2];
  return {
    frontmatterBlock: content.slice(0, content.length - body.length),
    body,
  };
}

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

// Set (or, with an empty/undefined value, remove) scalar keys in a file's
// frontmatter, leaving the body and every other key untouched. If the file has
// no frontmatter block, one is created. Used to edit a single field
// programmatically without round-tripping the whole document through a YAML
// serializer — matches the deliberately-minimal reader above.
export function setFrontmatterKeys(
  content: string,
  updates: Record<string, string | undefined>,
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const match = content.match(FRONTMATTER_RE);
  let lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? match[2] : content;

  // Update existing keys in place — preserving their position so an edited field
  // (e.g. the title) doesn't jump to the bottom of the block. A null/empty value
  // drops the line.
  const remaining = new Map(Object.entries(updates));
  lines = lines.flatMap((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return [line];
    const key = line.slice(0, idx).trim();
    if (!remaining.has(key)) return [line];
    const value = remaining.get(key);
    remaining.delete(key);
    return value != null && value !== "" ? [`${key}: ${value}`] : [];
  });

  // Append any keys that weren't already present (a value of empty/undefined for
  // a brand-new key is a no-op).
  for (const [key, value] of remaining) {
    if (value != null && value !== "") lines.push(`${key}: ${value}`);
  }

  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
}

// --- Tags value helpers -----------------------------------------------------
//
// A task's tags live in the frontmatter as a flat, comma-delimited scalar —
// `tags: easy, bug` — deliberately NOT a YAML list, so the minimal reader above
// keeps working and files stay grep-friendly for agents editing `tags:` in
// place. These three helpers own the split/normalize/join so the shape is
// defined once.

// Normalize one tag token to its canonical id: lowercase kebab. Non-alphanumeric
// runs collapse to a single hyphen; leading/trailing hyphens are stripped
// (mirrors slugify, kept local so this low-level module stays dependency-free).
// Returns "" for a token with no slug-able characters, so callers can drop it.
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Parse a `tags:` frontmatter value into a normalized, de-duplicated id list
// (order preserved). Absent/empty → []. Untagged = absence of the key.
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

// Serialize an id list back to the scalar value, normalizing + de-duping. Empty
// → "" so `setFrontmatterKeys` drops the `tags:` line entirely (untagged = no
// key, never `tags:` with an empty value).
export function serializeTagsValue(tags: string[]): string {
  return parseTagsValue(tags.join(",")).join(", ");
}
