import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireProjectAccess, requireProjectMemberById } from "./authz";
import {
  projectAutomationDefinition,
  type AutomationDefinitionProjection,
} from "./automationDefinitions";
import { nextRunForScheduleState } from "./automationSchedules";

type Automation = Doc<"automations">;

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as {
    [K in keyof T as undefined extends T[K] ? K : K]: Exclude<T[K], undefined>;
  };
}

async function automationByPath(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  automationPath: string,
) {
  return await ctx.db
    .query("automations")
    .withIndex("by_key", (q) =>
      q.eq("projectId", projectId).eq("automationPath", automationPath),
    )
    .unique();
}

function automationDoc(
  projectId: Id<"projects">,
  projection: AutomationDefinitionProjection,
  sourceUpdatedAt: number,
  now: number,
) {
  return {
    projectId,
    automationPath: projection.automationPath,
    name: projection.name,
    enabled: projection.enabled,
    schedule: projection.schedule,
    scheduleDescription: projection.scheduleDescription,
    timezone: projection.timezone,
    harness: projection.harness,
    model: projection.model,
    effort: projection.effort,
    prompt: projection.prompt,
    lastScheduledAt: projection.lastScheduledAt,
    nextRunAt: projection.nextRunAt,
    lastRunId: projection.lastRunId,
    validationError: projection.validationError,
    deleted: projection.deleted,
    sourceUpdatedAt,
    updatedAt: now,
  };
}

export async function projectSyncedAutomationFile(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    path: string;
    content: string;
    deleted: boolean;
    sourceUpdatedAt: number;
  },
) {
  const existing = await automationByPath(ctx, args.projectId, args.path);
  const projection = projectAutomationDefinition({
    path: args.path,
    content: args.content,
    deleted: args.deleted,
    previous: existing,
  });
  if (!projection) return null;

  const now = Date.now();
  const doc = automationDoc(args.projectId, projection, args.sourceUpdatedAt, now);
  if (existing) {
    await ctx.db.patch(existing._id, doc);
    return existing._id;
  }
  return await ctx.db.insert("automations", withoutUndefined(doc));
}

export const upsertFromFile = mutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
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
    return await projectSyncedAutomationFile(ctx, {
      projectId: access.project._id,
      path: args.path,
      content: args.content,
      deleted: args.deleted,
      sourceUpdatedAt: Date.now(),
    });
  },
});

export const rebuildFromFiles = mutation({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const files = await ctx.db
      .query("files")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();

    let projected = 0;
    for (const file of files) {
      const id = await projectSyncedAutomationFile(ctx, {
        projectId: access.project._id,
        path: file.path,
        content: file.content,
        deleted: file.deleted,
        sourceUpdatedAt: file.updatedAt,
      });
      if (id) projected += 1;
    }
    return projected;
  },
});

export const listAutomations = query({
  args: {
    projectId: v.id("projects"),
    includeDeleted: v.optional(v.boolean()),
    includeInvalid: v.optional(v.boolean()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const automations = await ctx.db
      .query("automations")
      .withIndex("by_project", (q) => q.eq("projectId", access.project._id))
      .collect();
    return automations
      .filter((automation) => args.includeDeleted || !automation.deleted)
      .filter(
        (automation) =>
          args.includeInvalid || automation.validationError === undefined,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const listDueAutomations = query({
  args: {
    projectId: v.id("projects"),
    now: v.optional(v.number()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const now = args.now ?? Date.now();
    return await ctx.db
      .query("automations")
      .withIndex("by_project_enabled_next_run", (q) =>
        q
          .eq("projectId", access.project._id)
          .eq("enabled", true)
          .lte("nextRunAt", now),
      )
      .filter((q) => q.eq(q.field("deleted"), false))
      .filter((q) => q.eq(q.field("validationError"), undefined))
      .collect();
  },
});

export const getAutomation = query({
  args: {
    projectId: v.id("projects"),
    automationPath: v.string(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Automation | null> => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    return await ctx.db
      .query("automations")
      .withIndex("by_key", (q) =>
        q
          .eq("projectId", access.project._id)
          .eq("automationPath", args.automationPath),
      )
      .unique();
  },
});

export const updateScheduleState = mutation({
  args: {
    projectId: v.id("projects"),
    automationPath: v.string(),
    lastScheduledAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    lastRunId: v.optional(v.string()),
    recomputeNextRunAt: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const automation = await ctx.db
      .query("automations")
      .withIndex("by_key", (q) =>
        q
          .eq("projectId", access.project._id)
          .eq("automationPath", args.automationPath),
      )
      .unique();
    if (!automation || automation.deleted) {
      throw new Error("Automation not found");
    }
    const lastScheduledAt = args.lastScheduledAt;
    const recomputeNextRunAt =
      args.recomputeNextRunAt ?? lastScheduledAt !== undefined;
    const nextRunAt =
      args.nextRunAt ??
      (recomputeNextRunAt
        ? nextRunForScheduleState(
            automation.schedule,
            automation.timezone,
            automation.enabled,
            lastScheduledAt ?? Date.now(),
          )
        : undefined);
    const patch: Partial<Automation> = withoutUndefined({
      lastScheduledAt,
      lastRunId: args.lastRunId,
      updatedAt: Date.now(),
    });
    if (args.nextRunAt !== undefined || recomputeNextRunAt) {
      patch.nextRunAt = nextRunAt;
    }
    await ctx.db.patch(automation._id, patch);
  },
});
