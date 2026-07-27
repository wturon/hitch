import { generateKeyBetween } from "fractional-indexing";

import { ensureOk, type Session } from "./api.js";
import { CliError } from "./errors.js";
import { shortId, resolveByPrefix } from "./ids.js";
import { truncate } from "./format.js";

// Server row shapes as they cross the wire (Dates arrive as ISO strings).
// Structural on purpose — the typed client's inferred responses assign to
// these, and the CLI never needs the drizzle types themselves.

export interface TaskRow {
  id: string;
  projectId: string | null;
  sectionId: string | null;
  title: string;
  body: string;
  status: "open" | "done";
  sortOrder: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  tagIds: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
  repoPath: string | null;
  sortOrder: string;
}

export interface SectionRow {
  id: string;
  projectId: string;
  name: string;
  sortOrder: string;
}

export interface TagRow {
  id: string;
  name: string;
  color: string;
}

const INBOX_NAME = "Inbox";

// Tag auto-create colors — V1's Notion-style rotation, same order as the
// desktop (desktop/src/renderer/lib/tagColors.ts): high-contrast hues first,
// gray (the unknown-tag fallback tint) last.
const TAG_COLOR_ROTATION = [
  "blue",
  "green",
  "orange",
  "purple",
  "pink",
  "yellow",
  "red",
  "brown",
  "gray",
] as const;

// ---------------------------------------------------------------------------
// Fetches
// ---------------------------------------------------------------------------

/** Every task the user has, all statuses — the resolution universe for id prefixes. */
export async function fetchAllTasks(session: Session): Promise<TaskRow[]> {
  const res = await session.client.tasks.$get({ query: {} });
  await ensureOk(session, res, "Listing tasks");
  return (await res.json()) as TaskRow[];
}

export async function fetchProjects(session: Session): Promise<ProjectRow[]> {
  const res = await session.client.projects.$get();
  await ensureOk(session, res, "Listing projects");
  return (await res.json()) as ProjectRow[];
}

export async function fetchSections(session: Session, projectId?: string): Promise<SectionRow[]> {
  const res = await session.client.sections.$get({
    query: projectId ? { project_id: projectId } : {},
  });
  await ensureOk(session, res, "Listing sections");
  return (await res.json()) as SectionRow[];
}

export async function fetchTags(session: Session): Promise<TagRow[]> {
  const res = await session.client.tags.$get();
  await ensureOk(session, res, "Listing tags");
  return (await res.json()) as TagRow[];
}

// ---------------------------------------------------------------------------
// Task refs (id or unique prefix)
// ---------------------------------------------------------------------------

/**
 * Resolve a task id/prefix against ALL the user's tasks. Errors teach: no
 * match points at `hitch tasks list`, an ambiguous prefix lists the matches
 * so the caller can pick a longer one.
 */
export async function resolveTaskRef(session: Session, ref: string): Promise<TaskRow> {
  const tasks = await fetchAllTasks(session);
  const match = resolveByPrefix(tasks, ref);
  if (match.kind === "one") return match.row;
  if (match.kind === "none") {
    throw new CliError(
      `No task matches '${ref}'. Find task ids with:\n` +
        `  hitch tasks list --status all\n` +
        `Any unambiguous id prefix works (listings print one per task).`,
    );
  }
  const allIds = tasks.map((t) => t.id);
  const lines = match.rows.map(
    (t) => `  ${shortId(t.id, allIds)}  ${t.status === "done" ? "done" : "open"}  ${truncate(t.title, 60)}`,
  );
  throw new CliError(
    `'${ref}' matches ${match.rows.length} tasks — use a longer prefix:\n${lines.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// Project refs (name or id/prefix)
// ---------------------------------------------------------------------------

function projectByName(projects: ProjectRow[], name: string): ProjectRow[] {
  const needle = name.toLowerCase();
  return projects.filter((p) => p.name.toLowerCase() === needle);
}

/** Resolve --project: exact name (case-insensitive) first, then id/prefix. */
export async function resolveProjectRef(session: Session, ref: string): Promise<ProjectRow> {
  const projects = await fetchProjects(session);
  const byName = projectByName(projects, ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const lines = byName.map((p) => `  ${p.id}  ${p.name}`);
    throw new CliError(
      `${byName.length} projects are named '${ref}' — pass an id instead:\n${lines.join("\n")}`,
    );
  }
  const byId = resolveByPrefix(projects, ref);
  if (byId.kind === "one") return byId.row;
  const names = projects.map((p) => `  ${p.name}`).join("\n");
  throw new CliError(
    `No project matches '${ref}'. Your projects:\n${names || "  (none)"}\n` +
      `Names match case-insensitively; a project id or unique id prefix also works.`,
  );
}

// ---------------------------------------------------------------------------
// Section refs (name or id/prefix, scoped to a project)
// ---------------------------------------------------------------------------

/** Resolve a section inside one project: exact name first, then id/prefix. */
export async function resolveSectionRef(
  session: Session,
  project: ProjectRow,
  ref: string,
): Promise<SectionRow> {
  const sections = await fetchSections(session, project.id);
  const needle = ref.toLowerCase();
  const byName = sections.filter((section) => section.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const lines = byName.map((section) => `  ${section.id}  ${section.name}`);
    throw new CliError(
      `${byName.length} sections in '${project.name}' are named '${ref}' — pass an id instead:\n` +
        lines.join("\n"),
    );
  }
  const byId = resolveByPrefix(sections, ref);
  if (byId.kind === "one") return byId.row;
  if (byId.kind === "many") {
    const allIds = sections.map((section) => section.id);
    const lines = byId.rows.map(
      (section) => `  ${shortId(section.id, allIds)}  ${section.name}`,
    );
    throw new CliError(
      `'${ref}' matches ${byId.rows.length} sections in '${project.name}' — use a longer prefix:\n` +
        lines.join("\n"),
    );
  }
  const names = sections.map((section) => `  ${section.name}`).join("\n");
  throw new CliError(
    `No section in '${project.name}' matches '${ref}'. Existing sections:\n` +
      `${names || "  (none)"}\n` +
      `Names match case-insensitively; a section id or unique id prefix also works.`,
  );
}

/**
 * The target project for `tasks add`: an explicit --project must exist
 * (typos must not silently create projects), while the default, Inbox, is
 * ensured by name — created on first use, exactly like the desktop shell.
 */
export async function resolveProjectForAdd(session: Session, ref: string | undefined): Promise<ProjectRow> {
  if (ref !== undefined && ref.toLowerCase() !== INBOX_NAME.toLowerCase()) {
    return resolveProjectRef(session, ref);
  }
  const projects = await fetchProjects(session);
  const existing = projectByName(projects, INBOX_NAME)[0];
  if (existing) return existing;
  // Before every existing project, so Inbox also sorts first server-side
  // (the desktop's ensure does the same).
  const sortOrder = generateKeyBetween(null, projects[0]?.sortOrder ?? null);
  const res = await session.client.projects.$post({ json: { name: INBOX_NAME, sortOrder } });
  await ensureOk(session, res, `Creating the ${INBOX_NAME} project`);
  return (await res.json()) as ProjectRow;
}

// ---------------------------------------------------------------------------
// Tags (by name; auto-created on add)
// ---------------------------------------------------------------------------

/** Resolve a tag from an already-fetched registry, case-insensitively. */
export function resolveTagByNameFrom(tags: readonly TagRow[], name: string): TagRow {
  const match = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (match) return match;
  const names = tags.map((t) => `  ${t.name}`).join("\n");
  throw new CliError(
    `No tag named '${name}'.${tags.length ? ` Existing tags:\n${names}` : " There are no tags yet."}\n` +
      `Tags are created by tagging a task: hitch tasks add "..." --tag ${name}`,
  );
}

/**
 * Resolve tag names for `tasks add`, creating any that don't exist yet with
 * the next rotation color (the desktop's create-on-assign behavior). Returns
 * rows in the caller's order, dupes collapsed case-insensitively.
 */
export async function ensureTags(session: Session, names: string[]): Promise<TagRow[]> {
  const tags = await fetchTags(session);
  const out: TagRow[] = [];
  let created = tags.length;
  for (const name of names) {
    const needle = name.toLowerCase();
    if (out.some((t) => t.name.toLowerCase() === needle)) continue;
    const existing = tags.find((t) => t.name.toLowerCase() === needle);
    if (existing) {
      out.push(existing);
      continue;
    }
    const color = TAG_COLOR_ROTATION[created % TAG_COLOR_ROTATION.length];
    created += 1;
    const res = await session.client.tags.$post({ json: { name, color } });
    await ensureOk(session, res, `Creating tag '${name}'`);
    out.push((await res.json()) as TagRow);
  }
  return out;
}

/** id → display name for rendering a task's tagIds. Unknown ids are dropped. */
export function tagNames(tagIds: readonly string[], tags: readonly TagRow[]): string[] {
  const byId = new Map(tags.map((t) => [t.id, t.name]));
  return tagIds.flatMap((id) => {
    const name = byId.get(id);
    return name ? [name] : [];
  });
}

/** The prepend sortOrder for a new task in `project` (top of the open list). */
export async function prependSortOrder(session: Session, projectId: string): Promise<string> {
  const res = await session.client.tasks.$get({
    query: { project_id: projectId, status: "open" },
  });
  await ensureOk(session, res, "Reading the project's task order");
  const rows = (await res.json()) as TaskRow[];
  return generateKeyBetween(null, rows[0]?.sortOrder ?? null);
}
