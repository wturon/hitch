import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireProjectMemberById } from "./authz";

// The single per-project backlog-order row, or null.
async function backlogOrderRow(ctx: QueryCtx, projectId: Id<"projects">) {
  return await ctx.db
    .query("backlogOrders")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .unique();
}

// The manual Backlog order for a project (todos-v1) — the ordered list of task
// rel-paths, front = top of backlog. Returns `[]` when the project has no
// stored order yet. Membership-gated, mirroring its neighbors. The client
// reconciles this against the live task set at read time (lib/todos.ts
// sortBacklog): stale paths are pruned and unlisted tasks appended, so the
// mutation can stay a dumb whole-list replace.
export const getBacklogOrder = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const row = await backlogOrderRow(ctx, access.project._id);
    return row?.order ?? [];
  },
});

// Replace a project's whole Backlog order (last-writer-wins). The client owns
// and sends the full ordered list —
// there is no partial/patch shape. Upserts the single `by_project` row.
export const setBacklogOrder = mutation({
  args: { projectId: v.id("projects"), order: v.array(v.string()) },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const existing = await backlogOrderRow(ctx, access.project._id);
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { order: args.order, updatedAt });
    } else {
      await ctx.db.insert("backlogOrders", {
        projectId: access.project._id,
        order: args.order,
        updatedAt,
      });
    }
  },
});
