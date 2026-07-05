import {
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  projectMembershipForUser,
  requireProjectMember,
  requireProjectMemberById,
  requireProjectOwnerById,
  requireUser,
} from "./authz";

const PROJECT_CONFIG_PATH = "project.json";

// Todos v1 dropped the board and its per-project status config. project.json is
// now a minimal synced descriptor (no `tasks.statuses`/`defaultStatus`/
// `archiveStatus`); groups are derived client-side from task frontmatter.
type ProjectDoc = Pick<Doc<"projects">, "_id" | "name">;

function projectConfigContent(project: ProjectDoc) {
  const config = {
    version: 1,
    projectId: project._id,
    name: project.name,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function upsertProjectConfigFile(ctx: MutationCtx, project: ProjectDoc) {
  const content = projectConfigContent(project);
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
