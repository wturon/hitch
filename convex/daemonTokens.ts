import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import {
  requireUser,
  requireWorkspaceOwnerBySlug,
  sha256,
  workspaceBySlug,
} from "./authz";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `hitchdt_${body}`;
}

async function ensureWorkspaceForOwner(ctx: MutationCtx, slug: string) {
  const existing = await workspaceBySlug(ctx, slug);
  if (existing) return existing;

  const user = await requireUser(ctx);
  const now = Date.now();
  const workspaceId = await ctx.db.insert("workspaces", {
    name: slug,
    slug,
    createdBy: user._id,
    createdAt: now,
  });
  await ctx.db.insert("workspaceMembers", {
    workspaceId,
    userId: user._id,
    role: "owner",
    createdAt: now,
  });
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace) throw new Error("Workspace creation failed");
  return workspace;
}

export const list = query({
  args: { workspace: v.string() },
  handler: async (ctx, args) => {
    const workspace = await workspaceBySlug(ctx, args.workspace);
    if (!workspace) {
      await requireUser(ctx);
      return [];
    }
    await requireWorkspaceOwnerBySlug(ctx, args.workspace);
    return await ctx.db
      .query("daemonTokens")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .collect();
  },
});

export const create = mutation({
  args: {
    workspace: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const workspace = await ensureWorkspaceForOwner(ctx, args.workspace);
    await requireWorkspaceOwnerBySlug(ctx, workspace.slug);

    const token = randomToken();
    const now = Date.now();
    const id = await ctx.db.insert("daemonTokens", {
      workspaceId: workspace._id,
      name: args.name,
      tokenHash: await sha256(token),
      createdBy: (await requireUser(ctx))._id,
      createdAt: now,
    });
    return { id, token };
  },
});

export const revoke = mutation({
  args: {
    workspace: v.string(),
    id: v.id("daemonTokens"),
  },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceOwnerBySlug(ctx, args.workspace);
    const token = await ctx.db.get(args.id);
    if (!token || token.workspaceId !== workspace._id) {
      throw new Error("Daemon token not found");
    }
    await ctx.db.patch(args.id, { revokedAt: Date.now() });
  },
});
