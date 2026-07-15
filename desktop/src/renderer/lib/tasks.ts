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

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, ""); // re-strip in case the slice landed on a hyphen
}

// Fall back to the first line of the body when a task is saved without a title.
// Keyboard capture opens the dialog on the title, but a user can drop straight
// into the body and Esc out; rather than lose the thought (or create an untitled
// card), we name it from the first ~6 words of the first non-empty line, with the
// most common inline/leading markdown stripped so the title reads as plain prose.
// Returns "" when the body has no words, so the caller can discard an empty draft.
export function deriveTitleFromBody(body: string, maxWords = 6): string {
  const firstLine =
    body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, "") // heading markers
    .replace(/^>\s+/, "") // blockquote
    .replace(/^[-*+]\s+/, "") // bullet
    .replace(/^\d+\.\s+/, "") // ordered-list marker
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links/images → their text
    .replace(/[*_`~]/g, "") // emphasis / code / strike marks
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").filter(Boolean).slice(0, maxWords).join(" ");
}

// A slug for `title` that doesn't collide with `taken`, appending -2, -3, …
// Falls back to `fallback` ("task" by default) when the title has no slug-able
// characters.
export function uniqueSlug(
  title: string,
  taken: Set<string>,
  fallback = "task",
): string {
  const base = slugify(title) || fallback;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
