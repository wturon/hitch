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
