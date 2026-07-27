import { generateKeyBetween } from "fractional-indexing";

import { ensureOk, type Session } from "./api.js";
import { CliError } from "./errors.js";
import { truncate } from "./format.js";
import { resolveByPrefix, shortId } from "./ids.js";

// Server row shapes as they cross the wire (Dates arrive as ISO strings).
// Structural on purpose — the typed client's inferred responses assign to
// these, and the CLI never needs the drizzle types themselves.

export interface TaskRow {
  id: string;
  // Every task returned by the owned routes has a project: ownership itself
  // flows through the inner-joined project row.
  projectId: string;
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

export interface AssignmentRow {
  id: string;
  taskId: string;
  machineId: string;
  harness: "claude" | "codex";
  prompt: string | null;
  model: string | null;
  effort: string | null;
  desiredState: "running" | "stopped";
  reviewedAt: string | null;
  observedState: "pending" | "spawning" | "running" | "waiting_input" | "done" | "dead";
  requestedChatId: string | null;
  chatId: string | null;
  worktree: string | null;
  createdAt: string;
  updatedAt: string;
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

export interface Workspace {
  tasks: TaskRow[];
  projects: ProjectRow[];
  sections: SectionRow[];
  tags: TagRow[];
  projectById: Map<string, ProjectRow>;
  sectionById: Map<string, SectionRow>;
  tagById: Map<string, TagRow>;
  tagByKey: Map<string, TagRow>;
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

export const tagKey = (name: string): string => name.toLowerCase();

// ---------------------------------------------------------------------------
// Fetch once, resolve in memory
// ---------------------------------------------------------------------------

async function fetchAllTasks(session: Session): Promise<TaskRow[]> {
  const res = await session.client.tasks.$get({ query: {} });
  await ensureOk(session, res, "Listing tasks");
  return (await res.json()) as TaskRow[];
}

export async function fetchProjects(session: Session): Promise<ProjectRow[]> {
  const res = await session.client.projects.$get();
  await ensureOk(session, res, "Listing projects");
  return (await res.json()) as ProjectRow[];
}

async function fetchSections(session: Session): Promise<SectionRow[]> {
  const res = await session.client.sections.$get({ query: {} });
  await ensureOk(session, res, "Listing sections");
  return (await res.json()) as SectionRow[];
}

export async function fetchTags(session: Session): Promise<TagRow[]> {
  const res = await session.client.tags.$get();
  await ensureOk(session, res, "Listing tags");
  return (await res.json()) as TagRow[];
}

export async function loadWorkspace(session: Session): Promise<Workspace> {
  const [tasks, projects, sections, tags] = await Promise.all([
    fetchAllTasks(session),
    fetchProjects(session),
    fetchSections(session),
    fetchTags(session),
  ]);
  return {
    tasks,
    projects,
    sections,
    tags,
    projectById: new Map(projects.map((project) => [project.id, project])),
    sectionById: new Map(sections.map((section) => [section.id, section])),
    tagById: new Map(tags.map((tag) => [tag.id, tag])),
    tagByKey: new Map(tags.map((tag) => [tagKey(tag.name), tag])),
  };
}

// ---------------------------------------------------------------------------
// Pure task/project/section/tag resolution
// ---------------------------------------------------------------------------

export function resolveTaskRef(workspace: Workspace, ref: string): TaskRow {
  const match = resolveByPrefix(workspace.tasks, ref);
  if (match.kind === "one") return match.row;
  if (match.kind === "none") {
    throw new CliError(
      `No task matches '${ref}'. Find task ids with:\n` +
        `  hitch tasks list --status all\n` +
        `Any unambiguous id prefix works (listings print one per task).`,
    );
  }
  const allIds = workspace.tasks.map((task) => task.id);
  const lines = match.rows.map(
    (task) =>
      `  ${shortId(task.id, allIds)}  ${task.status === "done" ? "done" : "open"}  ` +
      truncate(task.title, 60),
  );
  throw new CliError(
    `'${ref}' matches ${match.rows.length} tasks — use a longer prefix:\n${lines.join("\n")}`,
  );
}

function projectsByName(projects: readonly ProjectRow[], name: string): ProjectRow[] {
  const needle = name.toLowerCase();
  return projects.filter((project) => project.name.toLowerCase() === needle);
}

export function resolveProjectRef(workspace: Workspace, ref: string): ProjectRow {
  const byName = projectsByName(workspace.projects, ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const lines = byName.map((project) => `  ${project.id}  ${project.name}`);
    throw new CliError(
      `${byName.length} projects are named '${ref}' — pass an id instead:\n${lines.join("\n")}`,
    );
  }
  const byId = resolveByPrefix(workspace.projects, ref);
  if (byId.kind === "one") return byId.row;
  const names = workspace.projects.map((project) => `  ${project.name}`).join("\n");
  throw new CliError(
    `No project matches '${ref}'. Your projects:\n${names || "  (none)"}\n` +
      `Names match case-insensitively; a project id or unique id prefix also works.`,
  );
}

/**
 * Resolve a section by exact name or id/prefix. A project scopes names when
 * supplied; a globally unique name or id can stand alone and infer its project.
 */
export function resolveSectionRef(
  workspace: Workspace,
  ref: string,
  project?: ProjectRow,
): SectionRow {
  const candidates = project
    ? workspace.sections.filter((section) => section.projectId === project.id)
    : workspace.sections;
  const scope = project ? ` in '${project.name}'` : "";
  const label = (section: SectionRow): string => {
    if (project) return section.name;
    const owner = workspace.projectById.get(section.projectId)?.name ?? "?";
    return `${owner} / ${section.name}`;
  };
  const needle = ref.toLowerCase();
  const byName = candidates.filter((section) => section.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const lines = byName.map((section) => `  ${section.id}  ${label(section)}`);
    throw new CliError(
      `${byName.length} sections${scope} are named '${ref}' — pass an id instead:\n` +
        lines.join("\n"),
    );
  }
  const byId = resolveByPrefix(candidates, ref);
  if (byId.kind === "one") return byId.row;
  if (byId.kind === "many") {
    const allIds = candidates.map((section) => section.id);
    const lines = byId.rows.map(
      (section) => `  ${shortId(section.id, allIds)}  ${label(section)}`,
    );
    throw new CliError(
      `'${ref}' matches ${byId.rows.length} sections${scope} — use a longer prefix:\n` +
        lines.join("\n"),
    );
  }
  const names = candidates.map((section) => `  ${label(section)}`).join("\n");
  throw new CliError(
    `No section${scope} matches '${ref}'. Existing sections:\n${names || "  (none)"}\n` +
      `Names match case-insensitively; a section id or unique id prefix also works.`,
  );
}

export function resolveTagByName(workspace: Workspace, name: string): TagRow {
  const match = workspace.tagByKey.get(tagKey(name));
  if (match) return match;
  const names = workspace.tags.map((tag) => `  ${tag.name}`).join("\n");
  throw new CliError(
    `No tag named '${name}'.` +
      `${workspace.tags.length ? ` Existing tags:\n${names}` : " There are no tags yet."}\n` +
      `Tags are created by tagging a task: hitch tasks add "..." --tag ${name}`,
  );
}

// ---------------------------------------------------------------------------
// Mutating resolution helpers
// ---------------------------------------------------------------------------

export async function resolveProjectForAdd(
  session: Session,
  workspace: Workspace,
  ref: string | undefined,
): Promise<ProjectRow> {
  if (ref !== undefined && ref.toLowerCase() !== INBOX_NAME.toLowerCase()) {
    return resolveProjectRef(workspace, ref);
  }
  const existing = projectsByName(workspace.projects, INBOX_NAME)[0];
  if (existing) return existing;
  const sortOrder = generateKeyBetween(null, workspace.projects[0]?.sortOrder ?? null);
  const res = await session.client.projects.$post({ json: { name: INBOX_NAME, sortOrder } });
  await ensureOk(session, res, `Creating the ${INBOX_NAME} project`);
  const created = (await res.json()) as ProjectRow;
  workspace.projects.unshift(created);
  workspace.projectById.set(created.id, created);
  return created;
}

/**
 * Resolve tag names against the loaded registry, creating unknown names with
 * the desktop color rotation. The workspace is updated in place, so every
 * later projection in the command observes exactly the same registry.
 */
export async function ensureTags(
  session: Session,
  workspace: Workspace,
  names: readonly string[],
): Promise<TagRow[]> {
  const out: TagRow[] = [];
  for (const name of names) {
    const key = tagKey(name);
    if (out.some((tag) => tagKey(tag.name) === key)) continue;
    const existing = workspace.tagByKey.get(key);
    if (existing) {
      out.push(existing);
      continue;
    }
    const color = TAG_COLOR_ROTATION[workspace.tags.length % TAG_COLOR_ROTATION.length];
    const res = await session.client.tags.$post({ json: { name, color } });
    await ensureOk(session, res, `Creating tag '${name}'`);
    const created = (await res.json()) as TagRow;
    workspace.tags.push(created);
    workspace.tagById.set(created.id, created);
    workspace.tagByKey.set(key, created);
    out.push(created);
  }
  return out;
}

export function tagNames(tagIds: readonly string[], workspace: Workspace): string[] {
  return tagIds.flatMap((id) => {
    const name = workspace.tagById.get(id)?.name;
    return name ? [name] : [];
  });
}

export function prependSortOrder(workspace: Workspace, projectId: string): string {
  const first = workspace.tasks.find(
    (task) => task.projectId === projectId && task.status === "open",
  );
  return generateKeyBetween(null, first?.sortOrder ?? null);
}
