import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { getCurrentUser, requireUser } from "./authz";

// Per-user snippet names are unique case-insensitively, but stored as typed —
// the by_user_name index only covers exact matches, so uniqueness is checked
// with a lowercase scan of the user's rows (snippet counts are small).
async function assertNameAvailable(
  ctx: MutationCtx,
  userId: Id<"users">,
  name: string,
  excludeId?: Id<"snippets">,
) {
  const lowered = name.toLowerCase();
  const rows = await ctx.db
    .query("snippets")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of rows) {
    if (row._id === excludeId) continue;
    if (row.name.toLowerCase() === lowered) {
      throw new Error(`A snippet named "${row.name}" already exists`);
    }
  }
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("snippets")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return rows.map((row) => ({
      _id: row._id,
      name: row.name,
      body: row.body,
      updatedAt: row.updatedAt,
    }));
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const name = args.name.trim();
    if (!name) throw new Error("Snippet name is required");
    if (!args.body.trim()) throw new Error("Snippet body is required");
    await assertNameAvailable(ctx, user._id, name);

    const now = Date.now();
    return await ctx.db.insert("snippets", {
      userId: user._id,
      name,
      body: args.body,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("snippets"),
    name: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== user._id) {
      throw new Error("Snippet not found");
    }
    const name = args.name.trim();
    if (!name) throw new Error("Snippet name is required");
    if (!args.body.trim()) throw new Error("Snippet body is required");
    await assertNameAvailable(ctx, user._id, name, args.id);

    await ctx.db.patch(args.id, {
      name,
      body: args.body,
      updatedAt: Date.now(),
    });
  },
});

export const remove = mutation({
  args: {
    id: v.id("snippets"),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const row = await ctx.db.get(args.id);
    if (!row || row.userId !== user._id) {
      throw new Error("Snippet not found");
    }
    await ctx.db.delete(args.id);
  },
});
