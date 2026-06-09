import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess, requireUser } from "./authz";

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

    const doc = {
      projectId: access.project._id,
      path: args.path,
      content: args.content,
      hash: args.hash,
      deleted: args.deleted,
      updatedAt: Date.now(),
    };
    if (existing) {
      if (existing.hash === args.hash && existing.deleted === args.deleted) {
        return;
      }
      await ctx.db.patch(existing._id, doc);
    } else {
      await ctx.db.insert("files", doc);
    }
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
// Leading YAML frontmatter block. Mirrors lib/frontmatter.ts FRONTMATTER_RE,
// but we only need the raw block, not the body.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

// Pull and normalize just the `chat-status` field from a task body's
// frontmatter. Server-side twin of parseFrontmatter + normalizeChatStatus in
// the renderer (lib/frontmatter.ts, lib/chat.ts) — kept narrow so the sidebar
// count query never has to ship full task contents to the client. Keep the
// status vocabulary (and aliases) in sync with lib/chat.ts.
function taskChatStatus(content: string): "working" | "needs-input" | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1 || line.slice(0, idx).trim() !== "chat-status") continue;
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .toLowerCase()
      .replace(/\s+/g, "-");
    if (
      value === "working" ||
      value === "active" ||
      value === "busy" ||
      value === "running"
    )
      return "working";
    if (
      value === "needs-input" ||
      value === "needs_input" ||
      value === "needs-help"
    )
      return "needs-input";
    // "waiting"/"ready"/"idle" and anything else don't count toward attention.
    return null;
  }
  return null;
}

// Per-project tallies of tasks whose chat is mid-turn ("working") or blocked on
// the human ("needs-input"), for the at-a-glance sidebar. Computed server-side
// and returned as small counts keyed by project id, so the client never has to
// subscribe to every project's full file contents just to show a badge.
// Reactive: re-runs when membership changes or any task in any of the user's
// projects is written. Projects with no attention-worthy tasks still get a
// {0,0} entry so the UI can tell "idle" apart from "still loading".
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
        const status = taskChatStatus(file.content);
        if (status === "working") working++;
        else if (status === "needs-input") needsInput++;
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
