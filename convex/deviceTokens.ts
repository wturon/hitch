import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import {
  requireUser,
  requireProjectMemberBySlug,
  sha256,
  projectBySlug,
} from "./authz";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `hitchdev_${body}`;
}

async function ensureProjectForMember(ctx: MutationCtx, slug: string) {
  const existing = await projectBySlug(ctx, slug);
  if (existing) {
    const access = await requireProjectMemberBySlug(ctx, slug);
    if (!access.project) throw new Error("Project does not exist");
    return access.project;
  }

  const user = await requireUser(ctx);
  const now = Date.now();
  const projectId = await ctx.db.insert("projects", {
    name: slug,
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
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("Project creation failed");
  return project;
}

export const list = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const { user } = await requireProjectMemberBySlug(ctx, args.project);
    return await ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

export const create = mutation({
  args: {
    project: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const project = await ensureProjectForMember(ctx, args.project);
    const user = await requireUser(ctx);
    await requireProjectMemberBySlug(ctx, project.slug);

    const token = randomToken();
    const now = Date.now();
    const id = await ctx.db.insert("deviceTokens", {
      userId: user._id,
      name: args.name,
      tokenHash: await sha256(token),
      createdAt: now,
    });
    return { id, token };
  },
});

export const revoke = mutation({
  args: {
    project: v.string(),
    id: v.id("deviceTokens"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireProjectMemberBySlug(ctx, args.project);
    const token = await ctx.db.get(args.id);
    if (!token || token.userId !== user._id) {
      throw new Error("Device token not found");
    }
    await ctx.db.patch(args.id, { revokedAt: Date.now() });
  },
});
