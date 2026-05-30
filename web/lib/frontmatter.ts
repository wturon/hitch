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
