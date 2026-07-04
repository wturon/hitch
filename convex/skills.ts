import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireProjectAccess, requireProjectMemberById } from "./authz";

// Where a skill is installed on disk. One skill name can have several installs
// (e.g. the same skill available to both claude-code and codex).
const skillInstall = v.object({
  harness: v.string(), // "claude-code" | "codex"
  scope: v.union(v.literal("global"), v.literal("project")),
  path: v.string(),
});

// Replace the full set of skills for a (projectId, host). The daemon scans the
// machine's skill directories on startup + on an interval and calls this with
// everything it found; the filesystem is the source of truth. Rows for this
// (projectId, host) that are no longer present are hard-deleted — unlike `files`
// there's no downstream consumer that needs a tombstone to learn a skill went
// away, so a plain delete keeps the derived index clean. Keyed by
// (projectId, host, name); one row per skill name with several `installs`.
export const replace = mutation({
  args: {
    projectId: v.id("projects"),
    host: v.string(),
    skills: v.array(
      v.object({
        name: v.string(),
        description: v.optional(v.string()),
        installs: v.array(skillInstall),
      }),
    ),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const projectId = access.project._id;
    const updatedAt = Date.now();

    const existing = await ctx.db
      .query("skills")
      .withIndex("by_key", (q) =>
        q.eq("projectId", projectId).eq("host", args.host),
      )
      .collect();
    const existingByName = new Map(existing.map((row) => [row.name, row]));

    const seen = new Set<string>();
    for (const skill of args.skills) {
      seen.add(skill.name);
      const base = {
        projectId,
        host: args.host,
        name: skill.name,
        installs: skill.installs,
        updatedAt,
      };
      const prior = existingByName.get(skill.name);
      if (prior) {
        // `description: undefined` on a patch clears a previously-set field.
        await ctx.db.patch(prior._id, {
          ...base,
          description: skill.description,
        });
      } else {
        // Insert can't carry an undefined value, so omit description when absent.
        await ctx.db.insert(
          "skills",
          skill.description !== undefined
            ? { ...base, description: skill.description }
            : base,
        );
      }
    }

    for (const row of existing) {
      if (!seen.has(row.name)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});

// All skill rows for a project, across every host that reported them. The
// renderer merges rows by name client-side (see hooks/useSkills.ts) — this just
// returns the raw rows.
export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    return await ctx.db
      .query("skills")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
  },
});
