import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireProjectMemberById,
  requireProjectOwnerById,
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

function normalizeStatuses(
  statuses:
    | Array<{
        id?: string;
        name?: string;
      }>
    | undefined,
) {
  const seen = new Set<string>();
  const normalized = [];

  for (const status of statuses ?? []) {
    const name = (status.name ?? "").trim().replace(/\s+/g, " ");
    const id = normalizeStatusId(status.id ?? name);
    if (!name || !id || id === "archived" || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, name: name.slice(0, 40) });
  }

  return normalized.length > 0 ? normalized : [...DEFAULT_STATUSES];
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
        return project ? { project, membership } : null;
      }),
    );
    return projects
      .filter((entry): entry is NonNullable<(typeof projects)[number]> => entry !== null)
      .sort((a, b) => a.project.name.localeCompare(b.project.name));
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
    const statuses = normalizeStatuses(args.statuses);

    await ctx.db.patch(access.project._id, { statuses });
    const project = await ctx.db.get(access.project._id);
    if (project) await upsertProjectConfigFile(ctx, project, statuses);
    return project;
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
