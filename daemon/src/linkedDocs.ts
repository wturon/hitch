// Single source of truth for the doc kinds whose chat link the daemon stamps
// and keeps projected/healed on disk: a task's `task.md`. Automations link a
// path too but aren't surfaced as editable docs, so they're intentionally
// excluded.
//
// This list drives four spots that must stay in lockstep — the projection SQL
// (`linked_type IN …`), the canonical-path regex, the reconcile walk, and the
// bind/stamp guard. Add a kind here (or start stamping automations) and all four
// follow from this one change instead of drifting apart.
export const LINKED_DOC_KINDS = [
  { type: "task", dir: "tasks", file: "task.md" },
] as const;

export type LinkedDocKind = (typeof LINKED_DOC_KINDS)[number];
export type LinkedDocType = LinkedDocKind["type"];

// `linkedType` values that map to a stampable doc body (task). A type guard so
// the daemon's bind path narrows `linkedType` alongside it.
export function isLinkedDocType(
  linkedType: string | undefined,
): linkedType is LinkedDocType {
  return LINKED_DOC_KINDS.some((kind) => kind.type === linkedType);
}

// The `linked_type IN (…)` value list for the lifecycle-store query. Built from
// trusted internal constants (never user input), so literal quoting is safe.
export const LINKED_DOC_TYPES_SQL = LINKED_DOC_KINDS.map(
  (kind) => `'${kind.type}'`,
).join(", ");

// True for a canonical doc-body path: `tasks/<slug>/task.md`. Used to gate
// frontmatter projection.
const LINKED_DOC_PATTERNS = LINKED_DOC_KINDS.map(
  (kind) => new RegExp(`^${kind.dir}/[^/]+/${kind.file.replace(/\./g, "\\.")}$`),
);
export function isLinkedDocPath(path: string): boolean {
  return LINKED_DOC_PATTERNS.some((re) => re.test(path));
}
