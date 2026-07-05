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

// Split captured stage-1 text into an independent title + remaining body at the
// FIRST newline (Todos v1, Decision 2 — "Option B, split once at ⌘⏎"). The first
// line crystallizes into the `title:` frontmatter; everything after it stays in
// the body. A one-line capture yields a title and an empty body. A run-on first
// line with no early newline is capped near `cap` chars (preferring the last word
// boundary within reach, else a hard cut) so a wall-of-text first line can't
// become the whole title — the overflow rejoins the body ahead of any later
// lines. Title and body never rewrite each other after this one split.
//
// Both halves are returned verbatim apart from trimming the title's own outer
// whitespace (a YAML scalar) and the single blank line the split consumes; body
// spacing is otherwise preserved so pasted markdown round-trips.
export function splitCaptureText(
  text: string,
  cap = 120,
): { title: string; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const nlIndex = normalized.indexOf("\n");
  const firstLine = nlIndex === -1 ? normalized : normalized.slice(0, nlIndex);
  const rest = nlIndex === -1 ? "" : normalized.slice(nlIndex + 1);
  const titleRaw = firstLine.trim();

  if (titleRaw.length <= cap) {
    return { title: titleRaw, body: rest };
  }

  // Run-on first line: break near `cap`, preferring the last space at/under it so
  // a word isn't sliced. Fall back to a hard cut when the nearest boundary is too
  // far back to be a sensible title.
  let breakAt = titleRaw.lastIndexOf(" ", cap);
  if (breakAt < cap * 0.6) breakAt = cap;
  const title = titleRaw.slice(0, breakAt).trim();
  const overflow = titleRaw.slice(breakAt).trim();
  const body = rest ? `${overflow}\n${rest}` : overflow;
  return { title, body };
}

// A slug for `title` that doesn't collide with `taken`, appending -2, -3, …
// Falls back to `fallback` ("task" by default) when the title has no slug-able
// characters — notes pass "note" so an untitled note reads sensibly.
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
