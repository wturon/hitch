// Flat YAML-frontmatter helpers shared by the daemon runtime and the Todos v1
// task-frontmatter migration. Deliberately flat (no nested YAML / lists), which
// keeps the daemon free of a YAML dependency. Extracted verbatim from daemon.ts
// so both callers rewrite frontmatter byte-identically — the migration relies on
// this to preserve body + all untouched keys (same guarantee linkClaudeSession
// leans on).

// Leading YAML frontmatter block: capture the block body and everything after.
export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Rewrite a set of flat frontmatter keys. Keys present in `updates` are dropped
// from their original position; those with a non-empty value are re-appended at
// the end of the block. Every untouched line and the whole body are preserved
// byte-for-byte. A key mapped to `undefined`/`""` is simply removed.
export function setFrontmatterKeys(
  content: string,
  updates: Record<string, string | undefined>,
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const match = content.match(FRONTMATTER_RE);
  let lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? match[2] : content;
  const touched = new Set(Object.keys(updates));

  lines = lines.filter((line) => {
    const idx = line.indexOf(":");
    return idx === -1 || !touched.has(line.slice(0, idx).trim());
  });

  for (const [key, value] of Object.entries(updates)) {
    if (value != null && value !== "") lines.push(`${key}: ${value}`);
  }

  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
}

// Read a single flat key from a document's frontmatter. Returns undefined when
// the doc has no frontmatter or the key is absent.
export function frontmatterValue(
  content: string,
  key: string,
): string | undefined {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return undefined;

  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() !== key) continue;
    return line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return undefined;
}
