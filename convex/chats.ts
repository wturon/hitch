import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  requireProjectAccess,
  requireProjectMemberById,
} from "./authz";

type Chat = Doc<"chats">;
type Harness = Chat["harness"];
type LinkedType = NonNullable<Chat["linkedType"]>;

const DEFAULT_HOME_LIMIT = 20;
const DEFAULT_PINNED_LIMIT = 20;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_LIMIT = 250;
const MAX_TITLE_LENGTH = 72;
const DEFAULT_COMMAND_TTL_MS = 5 * 60 * 1000;

function commandExpiry(now: number): number {
  return now + DEFAULT_COMMAND_TTL_MS;
}

const harnessValidator = v.union(v.literal("claude-code"), v.literal("codex"));
const statusValidator = v.union(
  v.literal("working"),
  v.literal("needs-input"),
  v.literal("waiting"),
  v.literal("idle"),
);
const environmentValidator = v.union(
  v.literal("cmux"),
  v.literal("codex-app"),
  v.literal("vscode"),
  v.literal("cursor"),
  v.literal("t3code"),
);
const linkedTypeValidator = v.union(
  v.literal("task"),
  v.literal("note"),
  v.literal("automation"),
);
const resumeKindValidator = v.union(
  v.literal("open-chat-command"),
  v.literal("external"),
);

function clampLimit(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

function isDeleted(chat: Chat) {
  return chat.deletedAt !== undefined;
}

function isArchived(chat: Chat) {
  return chat.archivedAt !== undefined;
}

function isPinned(chat: Chat) {
  return chat.pinned === true;
}

function isRunning(chat: Chat) {
  return chat.status === "working";
}

function runningRank(chat: Chat) {
  if (chat.status === "working") return 0;
  if (chat.status === "needs-input") return 1;
  return 2;
}

function eventTime(chat: Chat) {
  return Math.max(chat.lastEventAt, chat.updatedAt);
}

function comparePinned(a: Chat, b: Chat) {
  const byPinnedAt = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
  if (byPinnedAt !== 0) return byPinnedAt;
  return eventTime(b) - eventTime(a);
}

function compareRunningFirst(a: Chat, b: Chat) {
  const byStatus = runningRank(a) - runningRank(b);
  if (byStatus !== 0) return byStatus;
  return eventTime(b) - eventTime(a);
}

function compareArchived(a: Chat, b: Chat) {
  const byArchivedAt = (b.archivedAt ?? 0) - (a.archivedAt ?? 0);
  if (byArchivedAt !== 0) return byArchivedAt;
  return eventTime(b) - eventTime(a);
}

function searchableText(chat: Chat) {
  return [
    chat.title,
    chat.harness,
    chat.status,
    chat.chatId,
    chat.launchId,
    chat.cwd,
    chat.host,
    chat.environment,
    chat.linkedType,
    chat.linkedPath,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
}

function matchesSearch(chat: Chat, search: string | undefined) {
  const needle = search?.trim().toLowerCase();
  if (!needle) return true;
  return searchableText(chat).includes(needle);
}

function normalizeTitle(value: string | undefined, harness: Harness) {
  const fallback =
    harness === "codex" ? "Untitled Codex chat" : "Untitled Claude Code chat";
  const normalized = value?.replace(/\s+/g, " ").trim() || fallback;
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}

function launchId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `launch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLink(
  linkedType: LinkedType | undefined,
  linkedPath: string | undefined,
) {
  if (!linkedType && !linkedPath) return {};
  if (!linkedType || !linkedPath) {
    throw new Error("Both linkedType and linkedPath are required for chat links");
  }
  return { linkedType, linkedPath };
}

async function chatByLaunch(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  value: string,
) {
  return await ctx.db
    .query("chats")
    .withIndex("by_project_launch", (q) =>
      q.eq("projectId", projectId).eq("launchId", value),
    )
    .unique();
}

async function markAutomationRunSettledForLaunch(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    launchId: string | undefined;
    chatId: Id<"chats">;
    endedAt: number;
  },
) {
  if (!args.launchId) return;
  const run = await ctx.db
    .query("automationRuns")
    .withIndex("by_launch", (q) => q.eq("launchId", args.launchId))
    .unique();
  if (!run || run.projectId !== args.projectId || run.status !== "running") {
    return;
  }
  await ctx.db.patch(run._id, {
    status: "done",
    endedAt: args.endedAt,
    chatId: args.chatId,
    updatedAt: args.endedAt,
  });
}

function isSettledStatus(status: Chat["status"]) {
  return status === "waiting" || status === "idle";
}

async function chatByHarnessId(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    harness: Harness;
    chatId: string;
    host: string;
  },
) {
  return await ctx.db
    .query("chats")
    .withIndex("by_project_chat", (q) =>
      q
        .eq("projectId", args.projectId)
        .eq("harness", args.harness)
        .eq("chatId", args.chatId)
        .eq("host", args.host),
    )
    .unique();
}

async function requireProjectChat(
  ctx: MutationCtx,
  args: { id: Id<"chats">; projectId: Id<"projects"> },
) {
  const access = await requireProjectMemberById(ctx, args.projectId);
  const chat = await ctx.db.get(args.id);
  if (!chat || chat.projectId !== access.project._id || isDeleted(chat)) {
    throw new Error("Chat not found");
  }
  return { chat, project: access.project };
}

function resumeCommandForChat(
  chat: Pick<Chat, "projectId" | "host" | "harness" | "chatId" | "cwd">,
  now: number,
) {
  if (!chat.chatId) {
    throw new Error("Chat is not ready to resume");
  }
  return {
    projectId: chat.projectId,
    host: chat.host === "unknown" ? undefined : chat.host,
    kind: "open-chat",
    harness: chat.harness,
    sessionId: chat.chatId,
    cwd: chat.cwd,
    status: "pending",
    expiresAt: commandExpiry(now),
    createdAt: now,
    updatedAt: now,
  };
}

async function projectChats(
  ctx: QueryCtx,
  args: {
    projectId: Id<"projects">;
    deviceToken?: string;
  },
) {
  const access = await requireProjectAccess(
    ctx,
    args.projectId,
    args.deviceToken,
  );
  if (!access.project) throw new Error("Project does not exist");
  return await ctx.db
    .query("chats")
    .withIndex("by_project_updated", (q) =>
      q.eq("projectId", access.project._id),
    )
    .order("desc")
    .collect();
}

export const listHome = query({
  args: {
    projectId: v.id("projects"),
    search: v.optional(v.string()),
    pinnedLimit: v.optional(v.number()),
    recentLimit: v.optional(v.number()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await projectChats(ctx, args);
    const active = rows.filter(
      (chat) =>
        !isDeleted(chat) && !isArchived(chat) && matchesSearch(chat, args.search),
    );
    const pinnedLimit = clampLimit(args.pinnedLimit, DEFAULT_PINNED_LIMIT);
    const recentLimit = clampLimit(args.recentLimit, DEFAULT_HOME_LIMIT);

    return {
      runningCount: active.filter(isRunning).length,
      pinned: active.filter(isPinned).sort(comparePinned).slice(0, pinnedLimit),
      recent: active
        .filter((chat) => !isPinned(chat))
        .sort(compareRunningFirst)
        .slice(0, recentLimit),
    };
  },
});

export const listHistory = query({
  args: {
    projectId: v.id("projects"),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    archivedLimit: v.optional(v.number()),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = (await projectChats(ctx, args)).filter(
      (chat) => !isDeleted(chat) && matchesSearch(chat, args.search),
    );
    const limit = clampLimit(args.limit, DEFAULT_HISTORY_LIMIT);
    const archivedLimit = clampLimit(args.archivedLimit, DEFAULT_HISTORY_LIMIT);

    const active = rows.filter((chat) => !isArchived(chat));
    return {
      pinned: active.filter(isPinned).sort(comparePinned).slice(0, limit),
      all: active
        .filter((chat) => !isPinned(chat))
        .sort(compareRunningFirst)
        .slice(0, limit),
      archived: rows.filter(isArchived).sort(compareArchived).slice(0, archivedLimit),
    };
  },
});

export const getChat = query({
  args: {
    id: v.id("chats"),
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
    const chat = await ctx.db.get(args.id);
    if (!chat || chat.projectId !== access.project._id || isDeleted(chat)) {
      return null;
    }
    return chat;
  },
});

export const startChat = mutation({
  args: {
    projectId: v.id("projects"),
    harness: harnessValidator,
    initialPrompt: v.string(),
    cwd: v.optional(v.string()),
    host: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    title: v.optional(v.string()),
    linkedType: v.optional(linkedTypeValidator),
    linkedPath: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const now = Date.now();
    const id = launchId();
    const link = normalizeLink(args.linkedType, args.linkedPath);
    const cwd = args.cwd ?? "";
    const host = args.host ?? "unknown";
    const title = normalizeTitle(args.title ?? args.initialPrompt, args.harness);

    const chatId = await ctx.db.insert("chats", {
      projectId: access.project._id,
      launchId: id,
      harness: args.harness,
      pending: true,
      status: "working",
      title,
      cwd,
      host,
      linkedType: link.linkedType,
      linkedPath: link.linkedPath,
      resumeKind: "open-chat-command",
      resumePayload: {},
      firstObservedAt: now,
      lastEventAt: now,
      lastStatusAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const commandId = await ctx.db.insert("commands", {
      projectId: access.project._id,
      host: args.host,
      kind: "start-chat",
      harness: args.harness,
      launchId: id,
      path: link.linkedType === "task" ? link.linkedPath : undefined,
      linkedType: link.linkedType,
      linkedPath: link.linkedPath,
      initialPrompt: args.initialPrompt,
      title,
      cwd: args.cwd,
      model: args.model,
      effort: args.effort,
      status: "pending",
      expiresAt: commandExpiry(now),
      createdAt: now,
      updatedAt: now,
    });

    return { chatId, commandId, launchId: id };
  },
});

export const bindPendingChat = mutation({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.string(),
    launchId: v.string(),
    harness: harnessValidator,
    chatId: v.string(),
    host: v.string(),
    cwd: v.optional(v.string()),
    status: v.optional(statusValidator),
    environment: v.optional(environmentValidator),
    resumeKind: v.optional(resumeKindValidator),
    resumePayload: v.optional(v.any()),
    observedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");

    const existing = await chatByHarnessId(ctx, {
      projectId: project._id,
      harness: args.harness,
      chatId: args.chatId,
      host: args.host,
    });
    const pending = await chatByLaunch(ctx, project._id, args.launchId);
    if (!pending) throw new Error("Pending chat not found");
    if (pending.projectId !== project._id) throw new Error("Chat project mismatch");
    if (pending.harness !== args.harness) throw new Error("Chat harness mismatch");
    if (existing && existing._id !== pending._id) {
      throw new Error("Chat is already bound to another row");
    }

    const now = Date.now();
    const observedAt = args.observedAt ?? now;
    await ctx.db.patch(pending._id, {
      chatId: args.chatId,
      pending: false,
      status: args.status ?? pending.status,
      cwd: args.cwd ?? pending.cwd,
      host: args.host,
      environment: args.environment ?? pending.environment,
      resumeKind: args.resumeKind ?? pending.resumeKind,
      resumePayload: args.resumePayload ?? pending.resumePayload,
      lastEventAt: Math.max(pending.lastEventAt, observedAt),
      lastStatusAt:
        args.status && args.status !== pending.status
          ? observedAt
          : pending.lastStatusAt,
      updatedAt: now,
    });

    const nextStatus = args.status ?? pending.status;
    if (isSettledStatus(nextStatus)) {
      await markAutomationRunSettledForLaunch(ctx, {
        projectId: project._id,
        launchId: args.launchId,
        chatId: pending._id,
        endedAt: observedAt,
      });
    }

    return pending._id;
  },
});

export const upsertReducedState = mutation({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.string(),
    launchId: v.optional(v.string()),
    harness: harnessValidator,
    chatId: v.optional(v.string()),
    pending: v.optional(v.boolean()),
    status: statusValidator,
    title: v.optional(v.string()),
    cwd: v.string(),
    host: v.string(),
    environment: v.optional(environmentValidator),
    linkedType: v.optional(linkedTypeValidator),
    linkedPath: v.optional(v.string()),
    resumeKind: v.optional(resumeKindValidator),
    resumePayload: v.optional(v.any()),
    firstObservedAt: v.optional(v.number()),
    lastEventAt: v.number(),
    lastStatusAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!project) throw new Error("Project does not exist");
    if (!args.launchId && !args.chatId) {
      throw new Error("Either launchId or chatId is required");
    }

    const link = normalizeLink(args.linkedType, args.linkedPath);
    const now = Date.now();
    const byChat =
      args.chatId === undefined
        ? null
        : await chatByHarnessId(ctx, {
            projectId: project._id,
            harness: args.harness,
            chatId: args.chatId,
            host: args.host,
          });
    const byLaunch =
      args.launchId === undefined
        ? null
        : await chatByLaunch(ctx, project._id, args.launchId);
    const existing = byChat ?? byLaunch;
    if (byChat && byLaunch && byChat._id !== byLaunch._id) {
      throw new Error("Reduced chat identifiers match different rows");
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        launchId: args.launchId ?? existing.launchId,
        chatId: args.chatId ?? existing.chatId,
        pending: args.pending ?? (args.chatId ? false : existing.pending),
        status: args.status,
        title: normalizeTitle(args.title ?? existing.title, args.harness),
        cwd: args.cwd,
        host: args.host,
        environment: args.environment ?? existing.environment,
        linkedType:
          "linkedType" in link ? link.linkedType : existing.linkedType,
        linkedPath:
          "linkedPath" in link ? link.linkedPath : existing.linkedPath,
        resumeKind: args.resumeKind ?? existing.resumeKind,
        resumePayload: args.resumePayload ?? existing.resumePayload,
        lastEventAt: args.lastEventAt,
        lastStatusAt: args.lastStatusAt ?? args.lastEventAt,
        endedAt: args.endedAt ?? existing.endedAt,
        updatedAt: now,
      });
      if (args.launchId && isSettledStatus(args.status)) {
        await markAutomationRunSettledForLaunch(ctx, {
          projectId: project._id,
          launchId: args.launchId,
          chatId: existing._id,
          endedAt: args.lastStatusAt ?? args.lastEventAt,
        });
      }
      return existing._id;
    }

    const id = await ctx.db.insert("chats", {
      projectId: project._id,
      launchId: args.launchId,
      harness: args.harness,
      chatId: args.chatId,
      pending: args.pending ?? args.chatId === undefined,
      status: args.status,
      title: normalizeTitle(args.title, args.harness),
      cwd: args.cwd,
      host: args.host,
      environment: args.environment,
      linkedType: link.linkedType,
      linkedPath: link.linkedPath,
      resumeKind: args.resumeKind ?? "open-chat-command",
      resumePayload: args.resumePayload ?? {},
      firstObservedAt: args.firstObservedAt ?? args.lastEventAt,
      lastEventAt: args.lastEventAt,
      lastStatusAt: args.lastStatusAt ?? args.lastEventAt,
      endedAt: args.endedAt,
      createdAt: now,
      updatedAt: now,
    });
    if (args.launchId && isSettledStatus(args.status)) {
      await markAutomationRunSettledForLaunch(ctx, {
        projectId: project._id,
        launchId: args.launchId,
        chatId: id,
        endedAt: args.lastStatusAt ?? args.lastEventAt,
      });
    }
    return id;
  },
});

export const resumeChat = mutation({
  args: {
    projectId: v.id("projects"),
    id: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const { chat } = await requireProjectChat(ctx, args);
    if (chat.pending) {
      throw new Error("Chat is still starting");
    }
    if (chat.resumeKind !== "open-chat-command") {
      throw new Error("Chat does not support command-based resume");
    }

    const now = Date.now();
    return await ctx.db.insert("commands", resumeCommandForChat(chat, now));
  },
});

export const setPinned = mutation({
  args: {
    projectId: v.id("projects"),
    id: v.id("chats"),
    pinned: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { chat } = await requireProjectChat(ctx, args);
    const now = Date.now();
    await ctx.db.patch(chat._id, {
      pinned: args.pinned,
      pinnedAt: args.pinned ? now : undefined,
      updatedAt: now,
    });
    return chat._id;
  },
});

export const setArchived = mutation({
  args: {
    projectId: v.id("projects"),
    id: v.id("chats"),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { chat } = await requireProjectChat(ctx, args);
    const now = Date.now();
    await ctx.db.patch(chat._id, {
      archivedAt: args.archived ? now : undefined,
      updatedAt: now,
    });
    return chat._id;
  },
});

export const deleteChat = mutation({
  args: {
    projectId: v.id("projects"),
    id: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const { chat } = await requireProjectChat(ctx, args);
    const now = Date.now();
    await ctx.db.patch(chat._id, {
      deletedAt: now,
      updatedAt: now,
    });
    return chat._id;
  },
});
