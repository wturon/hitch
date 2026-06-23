import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { nextRunForScheduleState } from "./automationSchedules";

const TICK_BATCH_LIMIT = 100;
const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;

type Automation = Doc<"automations">;
type Harness = "claude-code" | "codex";

export type SchedulerPlanItem =
  | {
      kind: "enqueue";
      automationPath: string;
      scheduledFor: number;
      nextRunAt: number | undefined;
    }
  | {
      kind: "skip";
      automationPath: string;
      scheduledFor: number;
      nextRunAt: number | undefined;
      reason: "overlap";
    };

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

export function planSchedulerTick(
  automations: Array<
    Pick<
      Automation,
      | "automationPath"
      | "enabled"
      | "deleted"
      | "validationError"
      | "schedule"
      | "timezone"
      | "nextRunAt"
    >
  >,
  activeAutomationPaths: Set<string>,
  now: number,
): SchedulerPlanItem[] {
  return automations
    .filter((automation) => automation.enabled)
    .filter((automation) => !automation.deleted)
    .filter((automation) => automation.validationError === undefined)
    .filter(
      (automation): automation is typeof automation & { nextRunAt: number } =>
        automation.nextRunAt !== undefined && automation.nextRunAt <= now,
    )
    .map((automation) => {
      const scheduledFor = automation.nextRunAt;
      const nextRunAt = nextRunForScheduleState(
        automation.schedule,
        automation.timezone,
        automation.enabled,
        scheduledFor,
      );
      if (activeAutomationPaths.has(automation.automationPath)) {
        return {
          kind: "skip",
          reason: "overlap",
          automationPath: automation.automationPath,
          scheduledFor,
          nextRunAt,
        };
      }
      return {
        kind: "enqueue",
        automationPath: automation.automationPath,
        scheduledFor,
        nextRunAt,
      };
    });
}

async function activeScheduledRun(
  ctx: MutationCtx,
  automationId: Id<"automations">,
) {
  return await ctx.db
    .query("automationRuns")
    .withIndex("by_automation_status", (q) =>
      q.eq("automationId", automationId).eq("status", "running"),
    )
    .filter((q) => q.eq(q.field("trigger"), "schedule"))
    .first();
}

async function insertPendingChatAndCommand(
  ctx: MutationCtx,
  automation: Automation,
  scheduledFor: number,
  now: number,
) {
  const id = launchId();
  const title = normalizeTitle(automation.name);
  if (!supportedHarness(automation.harness)) {
    throw new Error(`unsupported automation harness: ${automation.harness}`);
  }
  const harness = automation.harness;
  const chatId = await ctx.db.insert("chats", {
    projectId: automation.projectId,
    launchId: id,
    harness,
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
  const commandId = await ctx.db.insert("commands", {
    projectId: automation.projectId,
    kind: "start-chat",
    harness,
    launchId: id,
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
  const runId = await ctx.db.insert("automationRuns", {
    projectId: automation.projectId,
    automationId: automation._id,
    automationPath: automation.automationPath,
    trigger: "schedule",
    scheduledFor,
    startedAt: now,
    commandId,
    chatId,
    launchId: id,
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  return { commandId, runId };
}

export const tickDueAutomations = internalMutation({
  args: {
    now: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.max(
      1,
      Math.min(TICK_BATCH_LIMIT, Math.floor(args.limit ?? TICK_BATCH_LIMIT)),
    );
    const due = await ctx.db
      .query("automations")
      .withIndex("by_enabled_next_run", (q) =>
        q.eq("enabled", true).lte("nextRunAt", now),
      )
      .filter((q) => q.eq(q.field("deleted"), false))
      .filter((q) => q.eq(q.field("validationError"), undefined))
      .take(limit);

    let enqueued = 0;
    let skipped = 0;
    for (const automation of due) {
      if (automation.nextRunAt === undefined) continue;
      const scheduledFor = automation.nextRunAt;
      const nextRunAt = nextRunForScheduleState(
        automation.schedule,
        automation.timezone,
        automation.enabled,
        scheduledFor,
      );
      const active = await activeScheduledRun(ctx, automation._id);
      if (active || !supportedHarness(automation.harness)) {
        const runId = await ctx.db.insert("automationRuns", {
          projectId: automation.projectId,
          automationId: automation._id,
          automationPath: automation.automationPath,
          trigger: "schedule",
          scheduledFor,
          endedAt: now,
          status: "skipped",
          skipReason: active ? "overlap" : "unsupported-harness",
          createdAt: now,
          updatedAt: now,
        });
        await ctx.db.patch(automation._id, {
          lastScheduledAt: scheduledFor,
          nextRunAt,
          lastRunId: runId,
          updatedAt: now,
        });
        skipped += 1;
        continue;
      }

      const { runId } = await insertPendingChatAndCommand(
        ctx,
        automation,
        scheduledFor,
        now,
      );
      await ctx.db.patch(automation._id, {
        lastScheduledAt: scheduledFor,
        nextRunAt,
        lastRunId: runId,
        updatedAt: now,
      });
      enqueued += 1;
    }
    return { scanned: due.length, enqueued, skipped };
  },
});
