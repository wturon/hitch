// THROWAWAY (deleted at M5). Pure per-task parsing: one V1 task file →
// the importable shape, applying D3 exactly (title, body VERBATIM, tags,
// open/done + completed_at). Everything else in the frontmatter (chat-*,
// created, archivedFrom, …) is deliberately dropped.

import { parseFrontmatter, parseTagsValue } from "./frontmatter.js";

export interface SourceTaskFile {
  // Project-relative V1 path, e.g. "tasks/<slug>/task.md".
  path: string;
  // Raw file content, byte-for-byte.
  content: string;
  // Recency in ms epoch: files-row updatedAt (export) or file mtime (dir).
  // Drives the V1 default backlog order (updatedAt desc) and the legacy
  // `status: done` completed_at fallback, mirroring the daemon migration's
  // mtime choice.
  updatedAtMs: number;
}

export interface ParsedTask {
  slug: string;
  title: string;
  body: string; // VERBATIM — never trimmed or re-encoded
  status: "open" | "done";
  completedAtMs: number | null; // null = open, or done with unparseable date
  tags: string[];
  updatedAtMs: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export type ParseOutcome =
  | { kind: "task"; task: ParsedTask }
  | { kind: "skipped"; skipped: SkippedFile };

// V1's canonical-task-body predicate (desktop lib/tasks.ts taskSlug): a task is
// exactly `tasks/<slug>/task.md`. Anything else under tasks/ is not a card.
const TASK_RE = /^tasks\/([^/]+)\/task\.md$/;

export function taskSlug(path: string): string | null {
  const match = path.match(TASK_RE);
  return match ? match[1] : null;
}

// Same normalization as daemon/src/taskFrontmatterMigration.ts normalizeStatus.
function normalizeStatus(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

// V1 presence rule (desktop lib/todos.ts timestampPresent): any non-empty
// value counts, even an unparseable date — presence decides the group, parsing
// only supplies the sort key.
function timestampPresent(raw: string | undefined): boolean {
  return (raw ?? "").trim() !== "";
}

function parseTimestamp(raw: string | undefined): number | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? null : t;
}

// Parse one source file. Returns a skip (with reason) for non-canonical paths
// and V1-archived tasks; otherwise the importable task.
//
// Status resolution, in V1 precedence order:
//   - `archived-at` present, or legacy `status: archived` → SKIPPED (V1 hides
//     archived tasks from every group; V2 has no archived state — D3 is
//     open|done only).
//   - `completed-at` present → done; completed_at = parsed value (null if the
//     value is junk — presence beats parseability, like V1).
//   - legacy `status: done` (pre-todos-v1-migration rows still in the Convex
//     export) → done; completed_at = the row's updatedAt, mirroring what the
//     daemon migration would have stamped from mtime.
//   - anything else (incl. legacy to-do/in-progress/review/…) → open.
export function parseTaskFile(file: SourceTaskFile): ParseOutcome {
  const slug = taskSlug(file.path);
  if (slug === null) {
    return {
      kind: "skipped",
      skipped: {
        path: file.path,
        reason: "not a canonical task body (tasks/<slug>/task.md) — not a card in V1 either",
      },
    };
  }

  const { frontmatter, body } = parseFrontmatter(file.content);
  const legacyStatus =
    frontmatter.status !== undefined ? normalizeStatus(frontmatter.status) : undefined;

  if (timestampPresent(frontmatter["archived-at"]) || legacyStatus === "archived") {
    return {
      kind: "skipped",
      skipped: { path: file.path, reason: "archived in V1 (hidden there; V2 has no archived state)" },
    };
  }

  let status: "open" | "done" = "open";
  let completedAtMs: number | null = null;
  if (timestampPresent(frontmatter["completed-at"])) {
    status = "done";
    completedAtMs = parseTimestamp(frontmatter["completed-at"]);
  } else if (legacyStatus === "done") {
    status = "done";
    completedAtMs = file.updatedAtMs;
  }

  return {
    kind: "task",
    task: {
      slug,
      title: frontmatter.title || slug, // V1 fallback: title || slug
      body,
      status,
      completedAtMs,
      tags: parseTagsValue(frontmatter.tags),
      updatedAtMs: file.updatedAtMs,
    },
  };
}

// tasks/config.json → tag id → named color. Registry is advisory in V1
// (unknown tags render gray), so parse defensively and default to gray.
export const DEFAULT_TAG_COLOR = "gray";

export function parseTagConfig(json: string | undefined): Map<string, string> {
  const colors = new Map<string, string>();
  if (!json) return colors;
  try {
    const parsed = JSON.parse(json) as { tags?: Array<{ id?: string; color?: string }> };
    for (const tag of parsed.tags ?? []) {
      if (typeof tag.id === "string" && tag.id && typeof tag.color === "string" && tag.color) {
        colors.set(tag.id, tag.color);
      }
    }
  } catch {
    // Malformed registry → all tags fall back to the default color.
  }
  return colors;
}
