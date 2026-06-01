import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireUser, requireProjectMemberBySlug, sha256 } from "./authz";

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `hitchdev_${body}`;
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

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
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
    const user = await requireUser(ctx);
    await requireProjectMemberBySlug(ctx, args.project);

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

export const authorizeDevice = mutation({
  args: {
    deviceId: v.string(),
    name: v.string(),
    hostname: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const existing = await ctx.db
      .query("deviceTokens")
      .withIndex("by_user_device", (q) =>
        q.eq("userId", user._id).eq("deviceId", args.deviceId),
      )
      .unique();

    const token = randomToken();
    const now = Date.now();

    if (existing && existing.revokedAt === undefined) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        hostname: args.hostname,
        tokenHash: await sha256(token),
        lastUsedAt: now,
      });
      return { id: existing._id, token };
    }

    const id = await ctx.db.insert("deviceTokens", {
      userId: user._id,
      deviceId: args.deviceId,
      name: args.name,
      hostname: args.hostname,
      tokenHash: await sha256(token),
      createdAt: now,
      lastUsedAt: now,
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
