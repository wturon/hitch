import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  projectMembershipForUser,
  requireProjectMember,
  requireProjectMemberById,
  requireProjectOwnerById,
  sha256,
  requireUser,
} from "./authz";

const DEFAULT_STATUSES = [
  { id: "todo", name: "To Do" },
  { id: "in-progress", name: "In Progress" },
  { id: "review", name: "Review" },
  { id: "done", name: "Done" },
] as const;

const PROJECT_CONFIG_PATH = "project.json";

type ProjectStatus = {
  id: string;
  name: string;
};

export type StatusCardCount = {
  statusId: string;
  count: number;
  configured: boolean;
};

type ProjectDoc = Pick<Doc<"projects">, "_id" | "name" | "statuses">;

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function normalizeStatusId(input: string): string {
  return slugify(input).slice(0, 40);
}

type StatusInput = {
  id?: string;
  name?: string;
};

function uniqueStatusId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) return baseId;

  for (let suffix = 2; ; suffix++) {
    const suffixText = `-${suffix}`;
    const prefix = baseId
      .slice(0, Math.max(1, 40 - suffixText.length))
      .replace(/-+$/g, "");
    const candidate = `${prefix}${suffixText}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}

export function normalizeStatuses(
  statuses: StatusInput[] | undefined,
  existingStatuses: readonly ProjectStatus[] = [],
): ProjectStatus[] {
  if (!statuses || statuses.length === 0) return [...DEFAULT_STATUSES];

  const existingById = new Map(
    existingStatuses.map((status) => [status.id, status]),
  );
  const existingIds = new Set(existingStatuses.map((status) => status.id));
  const seenExistingIds = new Set<string>();
  const usedOutputIds = new Set<string>();
  const inputs = statuses.map((status) => {
    const name = (status.name ?? "").trim().replace(/\s+/g, " ");
    const inputId = normalizeStatusId(status.id ?? "");
    const existing = inputId ? existingById.get(inputId) : undefined;
    const unchangedExisting =
      existing !== undefined &&
      existing.name.trim().replace(/\s+/g, " ") === name;
    return { name, inputId, unchangedExisting };
  });

  for (const input of inputs) {
    if (input.unchangedExisting) usedOutputIds.add(input.inputId);
  }

  const normalized: ProjectStatus[] = [];

  for (const input of inputs) {
    if (!input.name) throw new Error("Status name is required");

    if (input.inputId && existingIds.has(input.inputId)) {
      if (seenExistingIds.has(input.inputId)) {
        throw new Error(`Status id "${input.inputId}" appears more than once`);
      }
      seenExistingIds.add(input.inputId);
    }

    const baseId = input.unchangedExisting
      ? input.inputId
      : normalizeStatusId(input.name);
    if (!baseId) {
      throw new Error(`Status "${input.name}" must include a letter or number`);
    }
    if (baseId === "archived") {
      throw new Error('"archived" is a reserved status id');
    }

    const id = input.unchangedExisting
      ? input.inputId
      : uniqueStatusId(baseId, usedOutputIds);
    usedOutputIds.add(id);
    normalized.push({ id, name: input.name.slice(0, 40) });
  }

  if (normalized.length === 0) throw new Error("At least one status is required");
  return normalized;
}

// Task bodies live at `tasks/<slug>/task.md`; other files in a task folder
// aren't cards. Mirrors desktop/src/renderer/App.tsx task parsing.
const TASK_BODY_RE = /^tasks\/[^/]+\/task\.md$/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function taskStatusId(content: string): string | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1 || line.slice(0, idx).trim() !== "status") continue;
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase();
    return value || null;
  }

  return null;
}

export function taskContentWithStatus(
  content: string,
  nextStatusId: string,
): string | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const fullBlock = match[0];
  const opening = fullBlock.match(/^---(\r?\n)/);
  if (!opening) return null;

  const eol = opening[1];
  const lines = match[1].split(/\r?\n/);
  const nextLines = [...lines];
  let changed = false;

  for (let index = 0; index < nextLines.length; index++) {
    const line = nextLines[index];
    const delimiter = line.indexOf(":");
    if (delimiter === -1 || line.slice(0, delimiter).trim() !== "status") {
      continue;
    }
    nextLines[index] = `status: ${nextStatusId}`;
    changed = true;
    break;
  }

  if (!changed) return null;

  const nextBlock = `---${eol}${nextLines.join(eol)}${eol}---`;
  return `${nextBlock}${content.slice(fullBlock.length)}`;
}

type TaskStatusFile = {
  path: string;
  content: string;
  deleted: boolean;
};

export type StatusMigrationRepoint<TFile extends TaskStatusFile> = {
  file: TFile;
  nextStatusId: string;
  nextContent: string;
};

export type StatusMigrationPlan<TFile extends TaskStatusFile> = {
  statuses: ProjectStatus[];
  repoints: Array<StatusMigrationRepoint<TFile>>;
};

function taskFilesWithStatus<TFile extends TaskStatusFile>(
  files: readonly TFile[],
  statusId: string,
): TFile[] {
  return files.filter(
    (file) =>
      !file.deleted &&
      TASK_BODY_RE.test(file.path) &&
      taskStatusId(file.content) === statusId,
  );
}

function taskStatusRepoints<TFile extends TaskStatusFile>(
  files: readonly TFile[],
  fromStatusId: string,
  toStatusId: string,
): Array<StatusMigrationRepoint<TFile>> {
  const repoints: Array<StatusMigrationRepoint<TFile>> = [];

  for (const file of taskFilesWithStatus(files, fromStatusId)) {
    const nextContent = taskContentWithStatus(file.content, toStatusId);
    if (nextContent === null || nextContent === file.content) continue;
    repoints.push({ file, nextStatusId: toStatusId, nextContent });
  }

  return repoints;
}

export function renameStatusMigrationPlan<TFile extends TaskStatusFile>(
  currentStatuses: readonly ProjectStatus[],
  files: readonly TFile[],
  args: { statusId: string; name: string },
): StatusMigrationPlan<TFile> {
  const statusIndex = currentStatuses.findIndex(
    (status) => status.id === args.statusId,
  );
  if (statusIndex === -1) throw new Error("Status does not exist");

  const statuses = normalizeStatuses(
    currentStatuses.map((status, index) =>
      index === statusIndex ? { name: args.name } : status,
    ),
    currentStatuses,
  );
  const nextStatus = statuses[statusIndex];
  if (!nextStatus) throw new Error("Status migration failed");

  return {
    statuses,
    repoints: taskStatusRepoints(files, args.statusId, nextStatus.id),
  };
}

export function deleteStatusMigrationPlan<TFile extends TaskStatusFile>(
  currentStatuses: readonly ProjectStatus[],
  files: readonly TFile[],
  args: { statusId: string; destinationStatusId?: string },
): StatusMigrationPlan<TFile> {
  const statusIndex = currentStatuses.findIndex(
    (status) => status.id === args.statusId,
  );
  if (statusIndex === -1) throw new Error("Status does not exist");

  const destinationStatusId = args.destinationStatusId ?? null;
  if (destinationStatusId === args.statusId) {
    throw new Error("Destination status must be different");
  }
  if (
    destinationStatusId !== null &&
    destinationStatusId !== "archived" &&
    !currentStatuses.some((status) => status.id === destinationStatusId)
  ) {
    throw new Error("Destination status does not exist");
  }

  const affectedFiles = taskFilesWithStatus(files, args.statusId);
  if (destinationStatusId === null && affectedFiles.length > 0) {
    throw new Error("Destination status is required");
  }

  const statuses = currentStatuses.filter(
    (status) => status.id !== args.statusId,
  );
  if (statuses.length === 0) throw new Error("At least one status is required");

  return {
    statuses,
    repoints:
      destinationStatusId === null
        ? []
        : taskStatusRepoints(affectedFiles, args.statusId, destinationStatusId),
  };
}

export function moveCardsWithStatusPlan<TFile extends TaskStatusFile>(
  currentStatuses: readonly ProjectStatus[],
  files: readonly TFile[],
  args: { statusId: string; destinationStatusId: string },
): Array<StatusMigrationRepoint<TFile>> {
  if (args.destinationStatusId === args.statusId) {
    throw new Error("Destination status must be different");
  }
  if (
    args.destinationStatusId !== "archived" &&
    !currentStatuses.some((status) => status.id === args.destinationStatusId)
  ) {
    throw new Error("Destination status does not exist");
  }

  return taskStatusRepoints(files, args.statusId, args.destinationStatusId);
}

async function patchStatusMigrationFiles<TFile extends TaskStatusFile & Doc<"files">>(
  ctx: MutationCtx,
  repoints: ReadonlyArray<StatusMigrationRepoint<TFile>>,
) {
  for (const repoint of repoints) {
    await ctx.db.patch(repoint.file._id, {
      content: repoint.nextContent,
      hash: await sha256(repoint.nextContent),
      deleted: false,
      updatedAt: Date.now(),
    });
  }
}

export function countTaskStatuses(
  files: Array<{ path: string; content: string; deleted: boolean }>,
  statuses: readonly ProjectStatus[],
): StatusCardCount[] {
  const configuredStatuses = statuses.length > 0 ? statuses : DEFAULT_STATUSES;
  const configuredIds = new Set(configuredStatuses.map((status) => status.id));
  const counts = new Map<string, number>();

  for (const status of configuredStatuses) counts.set(status.id, 0);

  for (const file of files) {
    if (file.deleted || !TASK_BODY_RE.test(file.path)) continue;
    const statusId = taskStatusId(file.content) ?? configuredStatuses[0].id;
    counts.set(statusId, (counts.get(statusId) ?? 0) + 1);
  }

  const configuredCounts = configuredStatuses.map((status) => ({
    statusId: status.id,
    count: counts.get(status.id) ?? 0,
    configured: true,
  }));
  const unknownCounts = [...counts.entries()]
    .filter(([statusId]) => !configuredIds.has(statusId))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([statusId, count]) => ({
      statusId,
      count,
      configured: false,
    }));

  return [...configuredCounts, ...unknownCounts];
}

function projectConfigContent(project: ProjectDoc, statuses?: ProjectStatus[]) {
  const config = {
    version: 1,
    projectId: project._id,
    name: project.name,
    tasks: {
      statuses: normalizeStatuses(statuses ?? project.statuses),
      defaultStatus: "todo",
      archiveStatus: "archived",
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function upsertProjectConfigFile(
  ctx: MutationCtx,
  project: ProjectDoc,
  statuses?: ProjectStatus[],
) {
  const content = projectConfigContent(project, statuses);
  const existing = await ctx.db
    .query("files")
    .withIndex("by_key", (q) =>
      q.eq("projectId", project._id).eq("path", PROJECT_CONFIG_PATH),
    )
    .unique();
  const doc = {
    projectId: project._id,
    path: PROJECT_CONFIG_PATH,
    content,
    hash: content,
    deleted: false,
    updatedAt: Date.now(),
  };

  if (!existing) {
    await ctx.db.insert("files", doc);
    return;
  }

  if (
    existing.content === content &&
    existing.deleted === false &&
    existing.hash === content
  ) {
    return;
  }
  await ctx.db.patch(existing._id, doc);
}

export const current = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    return {
      project: access.project,
      membership: access.membership,
    };
  },
});

export const details = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);

    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    const members = await Promise.all(
      memberships.map(async (membership) => {
        const user = await ctx.db.get(membership.userId);
        return {
          membershipId: membership._id,
          userId: membership.userId,
          role: membership.role,
          createdAt: membership.createdAt,
          user: user
            ? {
                name: user.name,
                email: user.email,
                image: user.image,
              }
            : null,
        };
      }),
    );

    members.sort((a, b) => {
      if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
      const aName = a.user?.name ?? a.user?.email ?? "";
      const bName = b.user?.name ?? b.user?.email ?? "";
      return aName.localeCompare(bName);
    });

    return {
      project: access.project,
      membership: access.membership,
      members,
    };
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const projects = await Promise.all(
      memberships.map(async (membership) => {
        const project = await ctx.db.get(membership.projectId);
        return project
          ? {
              project,
              membership,
              pinned: membership.pinned === true,
              pinnedOrder: membership.pinnedOrder ?? null,
            }
          : null;
      }),
    );
    return projects
      .filter((entry): entry is NonNullable<(typeof projects)[number]> => entry !== null)
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
  },
});

// Pin or unpin a project for the signed-in user. Pinning appends to the end of
// the current pinned order (max + 1) so a freshly pinned project lands at the
// bottom of PINNED; unpinning clears both fields so it falls back into MORE.
export const setPinned = mutation({
  args: {
    projectId: v.id("projects"),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireProjectMember(
      ctx,
      args.projectId,
    );

    if (!args.pinned) {
      await ctx.db.patch(membership._id, {
        pinned: false,
        pinnedOrder: undefined,
      });
      return;
    }

    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const maxOrder = memberships.reduce(
      (max, m) => (m.pinned && m.pinnedOrder != null ? Math.max(max, m.pinnedOrder) : max),
      -1,
    );
    await ctx.db.patch(membership._id, {
      pinned: true,
      pinnedOrder: maxOrder + 1,
    });
  },
});

// Persist a manual drag-reorder of the PINNED group. Takes the full ordered
// list of pinned project ids and rewrites each membership's `pinnedOrder` to
// its index. Ignores ids the user can't access or that aren't currently
// pinned, so a stale client list can't pin or leak projects.
export const reorderPinned = mutation({
  args: {
    projectIds: v.array(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await Promise.all(
      args.projectIds.map(async (projectId, index) => {
        const membership = await projectMembershipForUser(
          ctx,
          projectId,
          user._id,
        );
        if (!membership || membership.pinned !== true) return;
        if (membership.pinnedOrder === index) return;
        await ctx.db.patch(membership._id, { pinnedOrder: index });
      }),
    );
  },
});

export const updateDetails = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectOwnerById(ctx, args.projectId);
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required");
    if (name.length > 120) throw new Error("Project name is too long");

    await ctx.db.patch(access.project._id, { name });
    const project = await ctx.db.get(access.project._id);
    if (project) await upsertProjectConfigFile(ctx, project);
    return project;
  },
});

export const ensureProjectConfig = mutation({
  args: {
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const existing = await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", PROJECT_CONFIG_PATH),
      )
      .unique();

    if (existing && !existing.deleted) {
      let shouldBackfill = false;
      try {
        const parsed = JSON.parse(existing.content) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          "projectId" in parsed &&
          (parsed as { projectId?: unknown }).projectId !== access.project._id
        ) {
          throw new Error("Project config belongs to a different project");
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("projectId" in parsed) ||
          (parsed as { projectId?: unknown }).projectId !== access.project._id
        ) {
          shouldBackfill = true;
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("different project")) {
          throw err;
        }
        shouldBackfill = true;
      }
      if (shouldBackfill) {
        await upsertProjectConfigFile(ctx, access.project);
        return await ctx.db
          .query("files")
          .withIndex("by_key", (q) =>
            q.eq("projectId", access.project._id).eq("path", PROJECT_CONFIG_PATH),
          )
          .unique();
      }
      return existing;
    }

    await upsertProjectConfigFile(ctx, access.project);
    return await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", PROJECT_CONFIG_PATH),
      )
      .unique();
  },
});

export const statusCardCounts = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args): Promise<StatusCardCount[]> => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();

    return countTaskStatuses(files, normalizeStatuses(access.project.statuses));
  },
});

export const updateStatuses = mutation({
  args: {
    projectId: v.id("projects"),
    statuses: v.array(
      v.object({
        id: v.string(),
        name: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectOwnerById(ctx, args.projectId);
    const statuses = normalizeStatuses(
      args.statuses,
      normalizeStatuses(access.project.statuses),
    );

    await ctx.db.patch(access.project._id, { statuses });
    const project = await ctx.db.get(access.project._id);
    if (project) await upsertProjectConfigFile(ctx, project, statuses);
    return project;
  },
});

export const renameStatusWithMigration = mutation({
  args: {
    projectId: v.id("projects"),
    statusId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectOwnerById(ctx, args.projectId);
    const currentStatuses = normalizeStatuses(access.project.statuses);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    const { statuses, repoints } = renameStatusMigrationPlan(
      currentStatuses,
      files,
      args,
    );

    await patchStatusMigrationFiles(ctx, repoints);
    await ctx.db.patch(access.project._id, { statuses });
    const project = await ctx.db.get(access.project._id);
    if (project) await upsertProjectConfigFile(ctx, project, statuses);
    return project;
  },
});

export const deleteStatusWithMigration = mutation({
  args: {
    projectId: v.id("projects"),
    statusId: v.string(),
    destinationStatusId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectOwnerById(ctx, args.projectId);
    const currentStatuses = normalizeStatuses(access.project.statuses);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    const { statuses, repoints } = deleteStatusMigrationPlan(
      currentStatuses,
      files,
      args,
    );

    await patchStatusMigrationFiles(ctx, repoints);
    await ctx.db.patch(access.project._id, { statuses });
    const project = await ctx.db.get(access.project._id);
    if (project) await upsertProjectConfigFile(ctx, project, statuses);
    return project;
  },
});

export const moveCardsWithStatus = mutation({
  args: {
    projectId: v.id("projects"),
    statusId: v.string(),
    destinationStatusId: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectOwnerById(ctx, args.projectId);
    const currentStatuses = normalizeStatuses(access.project.statuses);
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    const repoints = moveCardsWithStatusPlan(currentStatuses, files, args);

    await patchStatusMigrationFiles(ctx, repoints);
    return { moved: repoints.length };
  },
});

export const create = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const now = Date.now();
    const name = args.name.trim() || "Project";
    const projectId = await ctx.db.insert("projects", {
      name,
      statuses: [...DEFAULT_STATUSES],
      createdBy: user._id,
      createdAt: now,
    });
    await ctx.db.insert("projectMembers", {
      projectId,
      userId: user._id,
      role: "owner",
      createdAt: now,
    });
    const project = await ctx.db.get(projectId);
    if (project) await upsertProjectConfigFile(ctx, project);
    return await ctx.db.get(projectId);
  },
});
