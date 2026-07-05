import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess, requireUser } from "./authz";
import { projectSyncedAutomationFile } from "./automations";
import { taskCountedGroup } from "./todoGroups";

// Insert or update a file by its (projectId, path) key. A delete is just an
// upsert with deleted: true (a tombstone) so other machines learn to remove the
// file locally.
export const upsertFile = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
    hash: v.string(),
    deleted: v.boolean(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const existing = await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.path),
      )
      .unique();

    const updatedAt = Date.now();
    const doc = {
      projectId: access.project._id,
      path: args.path,
      content: args.content,
      hash: args.hash,
      deleted: args.deleted,
      updatedAt,
    };
    if (existing) {
      if (existing.hash === args.hash && existing.deleted === args.deleted) {
        return;
      }
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("files", doc);
    }
    await projectSyncedAutomationFile(ctx, {
      projectId: access.project._id,
      path: args.path,
      content: args.content,
      deleted: args.deleted,
      sourceUpdatedAt: updatedAt,
    });
  },
});

// All files for a project (including tombstones, so the daemon can apply
// deletes). The desktop UI filters out deleted rows.
export const listFiles = query({
  args: { projectId: v.id("projects"), deviceToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
  },
});

// Task bodies live at `tasks/<slug>/task.md`; other files in a task folder
// aren't cards. Mirrors lib/tasks.ts TASK_RE.
const TASK_BODY_RE = /^tasks\/[^/]+\/task\.md$/;

// Per-project tallies for the at-a-glance sidebar badges: tasks in the WORKING
// group (spinner count) and the NEEDS YOU group (amber count). Under todos-v1
// these are DERIVED, not raw `chat-status` reads: `working` = a pending/failed
// summon flag OR a bound chat that is mid-turn; `needs-you` = a bound chat that
// isn't working and isn't completed/archived. The predicate lives in the pure
// ./todoGroups module (server-side twin of lib/todos.ts groupOf, honoring the
// slice-1→5 compat shim) so the badges match the Todos list exactly. Computed
// server-side and returned as small counts keyed by project id, so the client
// never has to subscribe to every project's full file contents. Reactive:
// re-runs when membership changes or any task is written. Projects with no
// attention-worthy tasks still get a {0,0} entry so the UI can tell "idle" apart
// from "still loading". The `needsInput` key name is retained for the existing
// AppSidebar consumer; it now carries the NEEDS YOU group count.
export const chatStatusCounts = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();

    const counts: Record<string, { working: number; needsInput: number }> = {};
    for (const membership of memberships) {
      const files = await ctx.db
        .query("files")
        .withIndex("by_project", (q) => q.eq("projectId", membership.projectId))
        .collect();
      let working = 0;
      let needsInput = 0;
      for (const file of files) {
        if (file.deleted || !TASK_BODY_RE.test(file.path)) continue;
        const group = taskCountedGroup(file.content);
        if (group === "working") working++;
        else if (group === "needs-you") needsInput++;
      }
      counts[membership.projectId] = { working, needsInput };
    }
    return counts;
  },
});

// A single file by its (projectId, path) key. Returns null if missing.
export const getFile = query({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.path),
      )
      .unique();
  },
});
