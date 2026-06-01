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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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

  // Drop existing lines for any key we're about to set or clear.
  const touched = new Set(Object.keys(updates));
  lines = lines.filter((line) => {
    const idx = line.indexOf(":");
    return idx === -1 || !touched.has(line.slice(0, idx).trim());
  });

  // Re-append the ones with a value; an empty/undefined value means "remove".
  for (const [key, value] of Object.entries(updates)) {
    if (value != null && value !== "") lines.push(`${key}: ${value}`);
  }

  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
}
