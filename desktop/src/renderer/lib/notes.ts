// A note is a folder under `notes/`, its body in index.md; other files in the
// folder (attachments) are not notes. This is the "note = folder" grouping
// convention on top of the file primitive, mirroring "task = folder" in tasks.ts
// exactly — the daemon still syncs individual files.
//
// Reuse slugify/uniqueSlug from tasks.ts (with the "note" fallback) rather than
// duplicating the slug machinery.

const NOTES_RE = /^notes\/([^/]+)\/index\.md$/;

// The slug for a note's canonical file, or null if `path` isn't one.
export function noteSlug(path: string): string | null {
  const match = path.match(NOTES_RE);
  return match ? match[1] : null;
}

// The on-disk path of a note's canonical body, from its slug.
export function noteBodyPath(slug: string): string {
  return `notes/${slug}/index.md`;
}
