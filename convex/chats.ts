import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireProjectAccess } from "./authz";

type Chat = Doc<"chats">;

const DEFAULT_HOME_LIMIT = 20;
const DEFAULT_PINNED_LIMIT = 20;
const DEFAULT_HISTORY_LIMIT = 100;
const MAX_LIMIT = 250;

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
