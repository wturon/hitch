// A task is a folder under `tasks/`, identified by its slug. The canonical
// body lives in `tasks/<slug>/task.md`; other files in the folder (attachments,
// later) are not cards. The daemon still syncs individual files — "task = folder"
// is purely this grouping convention on top of the file primitive.

const TASK_RE = /^tasks\/([^/]+)\/task\.md$/;

// The slug for a task's canonical file, or null if `path` isn't a task body.
export function taskSlug(path: string): string | null {
  const match = path.match(TASK_RE);
  return match ? match[1] : null;
}

// The on-disk path of a task's canonical body, from its slug.
export function taskBodyPath(slug: string): string {
  return `tasks/${slug}/task.md`;
}

// Kebab-case a title into a slug candidate. Lowercase, non-alphanumerics
// collapse to single hyphens, no leading/trailing hyphen. Deliberately ASCII-
// only (see the web-create task): unicode handling is out of scope for now.
//
// The result is capped at MAX_SLUG_LENGTH. A slug becomes a single path
// component (`tasks/<slug>/…`), and filesystems limit one component to 255
// bytes — an uncapped slug from a very long title makes the daemon's mkdir
// throw ENAMETOOLONG and crash on sync. 80 leaves ample headroom for the
// uniqueness suffix uniqueSlug appends.
const MAX_SLUG_LENGTH = 80;

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, ""); // re-strip in case the slice landed on a hyphen
}

// A slug for `title` that doesn't collide with `taken`, appending -2, -3, …
// Falls back to "task" when the title has no slug-able characters.
export function uniqueSlug(title: string, taken: Set<string>): string {
  const base = slugify(title) || "task";
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
