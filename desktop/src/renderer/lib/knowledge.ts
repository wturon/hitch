// A knowledge doc is a folder under `knowledge/`, identified by its slug. The
// canonical body lives in `knowledge/<slug>/index.md`; other files in the folder
// (attachments) are not docs. This mirrors the "task = folder" convention in
// tasks.ts exactly — the daemon still syncs individual files; "doc = folder" is
// purely this grouping on top of the file primitive.
//
// Reuse slugify/uniqueSlug from tasks.ts (with the "note" fallback for knowledge)
// rather than duplicating the slug machinery.

const KNOWLEDGE_RE = /^knowledge\/([^/]+)\/index\.md$/;

// The slug for a knowledge doc's canonical file, or null if `path` isn't one.
export function knowledgeSlug(path: string): string | null {
  const match = path.match(KNOWLEDGE_RE);
  return match ? match[1] : null;
}

// The on-disk path of a knowledge doc's canonical body, from its slug.
export function knowledgeBodyPath(slug: string): string {
  return `knowledge/${slug}/index.md`;
}
