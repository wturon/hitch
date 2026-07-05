import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess, requireUser } from "./authz";
import { projectSyncedAutomationFile } from "./automations";
// The Todos derivation core, imported straight from the renderer lib — the SAME
// module TodosView derives with, so the badge counts cannot drift from the
// list. The import chain (todos → chatModel/frontmatter/tasks) is pure by
// contract (no DOM, no React, no Convex imports — see chatModel.ts's purity
// note); Convex's esbuild bundles the relative imports outside convex/ fine.
import {
  indexChats,
  taskCountedGroup,
} from "../desktop/src/renderer/lib/todos";

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
// these are DERIVED with the same inputs the Todos list uses — task files PLUS
// the project's live chat rows — through the shared predicate core
// (lib/todos.ts taskCountedGroup): `working` = a pending/failed summon flag OR
// a bound chat whose LIVE row is mid-turn; `needs-you` = a bound chat that
// isn't working (including a frontmatter chat-id whose row is missing — a dead
// chat) and isn't completed/archived (compat shim honored). Computed
// server-side and returned as small counts keyed by project id, so the client
// never has to subscribe to every project's full file contents. Reactive:
// re-runs when membership changes or any task/chat is written. Projects with no
// attention-worthy tasks still get a {0,0} entry so the UI can tell "idle"
// apart from "still loading". The `needsInput` key name is retained for the
// existing AppSidebar consumer; it now carries the NEEDS YOU group count.
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
      // The live-chat index — same filter as chats.listForTodos (bound +
      // non-deleted; archived included, still ground truth for an attached
      // todo). Unlike the client, the server ALWAYS has the full chats table
      // in hand — there is no subscription loading state — so this query
      // always runs the derivation in index-supplied mode. (TodosView is the
      // one call site with a loading window; it derives index-less until rows
      // arrive. The two call sites intentionally differ in mode availability.)
      const chatRows = await ctx.db
        .query("chats")
        .withIndex("by_project", (q) => q.eq("projectId", membership.projectId))
        .collect();
      const chats = indexChats(
        chatRows.filter(
          (chat) => chat.deletedAt === undefined && chat.chatId !== undefined,
        ),
      );

      let working = 0;
      let needsInput = 0;
      for (const file of files) {
        if (file.deleted || !TASK_BODY_RE.test(file.path)) continue;
        const group = taskCountedGroup(file.content, chats);
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
