import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireProjectMemberBySlug,
  requireProjectOwnerBySlug,
  projectBySlug,
  requireUser,
} from "./authz";

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function uniqueSlug(ctx: Parameters<typeof projectBySlug>[0], base: string) {
  const root = slugify(base) || "project";
  let slug = root;
  let suffix = 2;
  while (await projectBySlug(ctx, slug)) {
    slug = `${root}-${suffix}`;
    suffix += 1;
  }
  return slug;
}

export const current = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberBySlug(ctx, args.project);
    if (!access.project) {
      return {
        project: null,
        membership: null,
        legacy: true,
      };
    }
    return {
      project: access.project,
      membership: access.membership,
      legacy: false,
    };
  },
});

export const details = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberBySlug(ctx, args.project);
    if (!access.project) return null;

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
    project: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectOwnerBySlug(ctx, args.project);
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required");
    if (name.length > 120) throw new Error("Project name is too long");

    await ctx.db.patch(access.project._id, { name });
    return await ctx.db.get(access.project._id);
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    slug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const now = Date.now();
    const slug = args.slug?.trim()
      ? await uniqueSlug(ctx, args.slug)
      : await uniqueSlug(ctx, args.name);
    const projectId = await ctx.db.insert("projects", {
      name: args.name.trim() || slug,
      slug,
      createdBy: user._id,
      createdAt: now,
    });
    await ctx.db.insert("projectMembers", {
      projectId,
      userId: user._id,
      role: "owner",
      createdAt: now,
    });
    return await ctx.db.get(projectId);
  },
});

export const claimLegacyProject = mutation({
  args: {
    project: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await projectBySlug(ctx, args.project);
    if (existing) {
      const access = await requireProjectMemberBySlug(ctx, args.project);
      return access.project;
    }

    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      name: args.name ?? args.project,
      slug: args.project,
      createdBy: user._id,
      createdAt: now,
    });
    await ctx.db.insert("projectMembers", {
      projectId,
      userId: user._id,
      role: "owner",
      createdAt: now,
    });
    return await ctx.db.get(projectId);
  },
});
