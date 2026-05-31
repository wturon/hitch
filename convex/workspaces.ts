import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireUser,
  requireWorkspaceMemberBySlug,
  workspaceBySlug,
} from "./authz";

export const current = query({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
    const access = await requireWorkspaceMemberBySlug(ctx, args.workspace);
    if (!access.workspace) {
      return {
        workspace: null,
        membership: null,
        legacy: true,
      };
    }
    return {
      workspace: access.workspace,
      membership: access.membership,
      legacy: false,
    };
  },
});

export const claimLegacyWorkspace = mutation({
  args: {
    workspace: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await workspaceBySlug(ctx, args.workspace);
    if (existing) {
      const access = await requireWorkspaceMemberBySlug(ctx, args.workspace);
      return access.workspace;
    }

    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      name: args.name ?? args.workspace,
      slug: args.workspace,
      createdBy: user._id,
      createdAt: now,
    });
    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId: user._id,
      role: "owner",
      createdAt: now,
    });
    return await ctx.db.get(workspaceId);
  },
});
