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
type Harness = "claude-code" | "codex";

const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;
const MAX_RUN_LIMIT = 50;

function launchId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `automation-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function commandExpiry(now: number): number {
  return now + DEFAULT_COMMAND_TTL_MS;
}

function normalizeTitle(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim() || "Automation run";
  if (normalized.length <= 72) return normalized;
  return `${normalized.slice(0, 69).trimEnd()}...`;
}

function supportedHarness(value: string): value is Harness {
  return value === "claude-code" || value === "codex";
}

function runLimit(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(MAX_RUN_LIMIT, Math.floor(value)));
}

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
    const visible = automations
      .filter((automation) => args.includeDeleted || !automation.deleted)
      .filter(
        (automation) =>
          args.includeInvalid || automation.validationError === undefined,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
    return await Promise.all(
      visible.map(async (automation) => ({
        ...automation,
        lastRun: automation.lastRunId
          ? await ctx.db.get(automation.lastRunId as Id<"automationRuns">)
          : null,
      })),
    );
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

export const listRuns = query({
  args: {
    projectId: v.id("projects"),
    automationPath: v.string(),
    limit: v.optional(v.number()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const automation = await ctx.db
      .query("automations")
      .withIndex("by_key", (q) =>
        q
          .eq("projectId", access.project._id)
          .eq("automationPath", args.automationPath),
      )
      .unique();
    if (!automation) return [];
    const runs = await ctx.db
      .query("automationRuns")
      .withIndex("by_automation", (q) => q.eq("automationId", automation._id))
      .order("desc")
      .take(runLimit(args.limit));
    return await Promise.all(
      runs.map(async (run) => ({
        ...run,
        chat: run.chatId ? await ctx.db.get(run.chatId) : null,
      })),
    );
  },
});

export const runNow = mutation({
  args: {
    projectId: v.id("projects"),
    automationPath: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const automation = await automationByPath(
      ctx,
      access.project._id,
      args.automationPath,
    );
    if (!automation || automation.deleted) {
      throw new Error("Automation not found");
    }
    if (automation.validationError) {
      throw new Error(`Automation definition is invalid: ${automation.validationError}`);
    }

    const now = Date.now();
    const active = await ctx.db
      .query("automationRuns")
      .withIndex("by_automation_status", (q) =>
        q.eq("automationId", automation._id).eq("status", "running"),
      )
      .first();
    if (active) {
      const runId = await ctx.db.insert("automationRuns", {
        projectId: automation.projectId,
        automationId: automation._id,
        automationPath: automation.automationPath,
        trigger: "manual",
        scheduledFor: now,
        endedAt: now,
        status: "skipped",
        skipReason: "overlap",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(automation._id, {
        lastRunId: runId,
        updatedAt: now,
      });
      return { runId, skipped: true, reason: "overlap" };
    }

    if (!supportedHarness(automation.harness)) {
      throw new Error(`unsupported automation harness: ${automation.harness}`);
    }

    const id = launchId();
    const title = normalizeTitle(automation.name);
    const chatId = await ctx.db.insert("chats", {
      projectId: automation.projectId,
      launchId: id,
      harness: automation.harness,
      pending: true,
      status: "working",
      title,
      cwd: "",
      host: "unknown",
      linkedType: "automation",
      linkedPath: automation.automationPath,
      resumeKind: "open-chat-command",
      resumePayload: {},
      firstObservedAt: now,
      lastEventAt: now,
      lastStatusAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const runId = await ctx.db.insert("automationRuns", {
      projectId: automation.projectId,
      automationId: automation._id,
      automationPath: automation.automationPath,
      trigger: "manual",
      scheduledFor: now,
      startedAt: now,
      chatId,
      launchId: id,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    const commandId = await ctx.db.insert("commands", {
      projectId: automation.projectId,
      kind: "start-chat",
      harness: automation.harness,
      launchId: id,
      automationRunId: runId,
      linkedType: "automation",
      linkedPath: automation.automationPath,
      initialPrompt: automation.prompt,
      title,
      model: automation.model,
      effort: automation.effort,
      status: "pending",
      expiresAt: commandExpiry(now),
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(runId, { commandId, updatedAt: now });
    await ctx.db.patch(automation._id, { lastRunId: runId, updatedAt: now });
    return { runId, commandId, chatId, launchId: id, skipped: false };
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
