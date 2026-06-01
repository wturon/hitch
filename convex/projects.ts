import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireProjectMemberBySlug,
  projectBySlug,
  requireUser,
} from "./authz";

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
