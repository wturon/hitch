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

export function automationRunMatchesLifecycle(
  run: {
    projectId: Id<"projects">;
    automationPath: string;
    launchId?: string;
    status: "running" | "done" | "skipped";
  },
  args: {
    projectId: Id<"projects">;
    launchId?: string;
    automationRunId?: Id<"automationRuns">;
    linkedType?: LinkedType;
    linkedPath?: string;
  },
) {
  if (run.projectId !== args.projectId || run.status !== "running") {
    return false;
  }
  if (args.automationRunId === undefined) return true;

  if (args.launchId !== undefined && run.launchId !== args.launchId) {
    return false;
  }
  const hasAutomationLink =
    args.linkedType === "automation" && args.linkedPath !== undefined;
  if (hasAutomationLink && run.automationPath !== args.linkedPath) {
    return false;
  }
  return args.launchId !== undefined || hasAutomationLink;
}

async function markAutomationRunSettledForLaunch(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    launchId: string | undefined;
    automationRunId?: Id<"automationRuns">;
    linkedType?: LinkedType;
    linkedPath?: string;
    chatId: Id<"chats">;
    endedAt: number;
  },
) {
  const run =
    args.automationRunId !== undefined
      ? await ctx.db.get(args.automationRunId)
      : args.launchId
        ? await ctx.db
            .query("automationRuns")
            .withIndex("by_launch", (q) => q.eq("launchId", args.launchId))
            .unique()
        : null;
  if (!run || run.projectId !== args.projectId || run.status !== "running") {
    return;
  }
  if (!automationRunMatchesLifecycle(run, args)) return;
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

// The single chat linked to a given doc (a note's index.md or a task's task.md),
// or null. Backed by the `by_link` index so the note foot can ask exactly "does
// this doc own a chat?" without scraping a recency-truncated home list — the
// answer must hold for an idle chat that fell off the recent window, or the
// one-chat-per-note invariant breaks. Returns the newest active (non-deleted,
// non-archived) match.
export const getChatByLink = query({
  args: {
    projectId: v.id("projects"),
    linkedType: linkedTypeValidator,
    linkedPath: v.string(),
    deviceToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectAccess(
      ctx,
      args.projectId,
      args.deviceToken,
    );
    if (!access.project) throw new Error("Project does not exist");
    const rows = await ctx.db
      .query("chats")
      .withIndex("by_link", (q) =>
        q
          .eq("projectId", access.project._id)
          .eq("linkedType", args.linkedType)
          .eq("linkedPath", args.linkedPath),
      )
      .collect();
    const active = rows
      .filter((chat) => !isDeleted(chat) && !isArchived(chat))
      .sort((a, b) => eventTime(b) - eventTime(a));
    return active[0] ?? null;
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
    const title = normalizeTitle(args.title ?? args.initialPrompt, args.harness);

    // No chats row here — chat rows are born from ground truth (the daemon binds
    // the real session, or the observer discovers it). A launch is just a command
    // on the bus; the "summoning" state lives on the linked doc (see
    // requestDelegation) or, for doc-less launches, surfaces once the row binds.
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

    return { commandId, launchId: id };
  },
});

// Fire-and-forget delegation from a task/note. Atomically (a) stamps the linked
// doc's frontmatter with the `chat-request` summoning flag — the client passes
// the already-stamped content + hash, mirroring the upsertFile contract — and
// (b) enqueues the start-chat command. No chats row: the daemon creates one when
// it binds the real session, and clears the flag then (or flips it to `failed`).
export const requestDelegation = mutation({
  args: {
    projectId: v.id("projects"),
    harness: harnessValidator,
    initialPrompt: v.string(),
    linkedType: linkedTypeValidator,
    linkedPath: v.string(),
    // The linked doc, re-stamped with `chat-request: requested` by the client so
    // the board reflects "summoning" the instant this mutation returns.
    content: v.string(),
    hash: v.string(),
    cwd: v.optional(v.string()),
    host: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireProjectMemberById(ctx, args.projectId);
    const now = Date.now();
    const id = launchId();
    const title = normalizeTitle(args.title ?? args.initialPrompt, args.harness);

    // Persist the stamped doc (same shape as files.upsertFile) so the flag rides
    // the files subscription to every open board and, via the daemon, to disk.
    const existing = await ctx.db
      .query("files")
      .withIndex("by_key", (q) =>
        q.eq("projectId", access.project._id).eq("path", args.linkedPath),
      )
      .unique();
    const fileDoc = {
      projectId: access.project._id,
      path: args.linkedPath,
      content: args.content,
      hash: args.hash,
      deleted: false,
      updatedAt: now,
    };
    if (existing) {
      await ctx.db.patch(existing._id, fileDoc);
    } else {
      await ctx.db.insert("files", fileDoc);
    }

    const commandId = await ctx.db.insert("commands", {
      projectId: access.project._id,
      host: args.host,
      kind: "start-chat",
      harness: args.harness,
      launchId: id,
      path: args.linkedType === "task" ? args.linkedPath : undefined,
      linkedType: args.linkedType,
      linkedPath: args.linkedPath,
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

    return { commandId, launchId: id };
  },
});

export const bindPendingChat = mutation({
  args: {
    projectId: v.id("projects"),
    deviceToken: v.string(),
    launchId: v.string(),
    automationRunId: v.optional(v.id("automationRuns")),
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
    // No preemptive pending row exists anymore (the client stopped creating one).
    // The reduced-state sync (upsertReducedState) that runs alongside every bind
    // is the authoritative creator now, so a missing row here is expected — no-op
    // rather than throw. This mutation only still matters when a pending row does
    // exist (e.g. the codex ID-gap launch row) and needs its link fields folded in.
    if (!pending) return null;
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
        automationRunId: args.automationRunId,
        linkedType: pending.linkedType,
        linkedPath: pending.linkedPath,
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
    automationRunId: v.optional(v.id("automationRuns")),
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
    observedStatus: v.optional(statusValidator),
    observedExistence: v.optional(
      v.union(v.literal("running"), v.literal("dormant"), v.literal("gone")),
    ),
    observedActivity: v.optional(
      v.union(v.literal("working"), v.literal("idle"), v.literal("unknown")),
    ),
    observedSource: v.optional(v.string()),
    observedAt: v.optional(v.number()),
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
    let existing = byChat ?? byLaunch;
    if (byChat && byLaunch && byChat._id !== byLaunch._id) {
      // A bind unified two rows that were created separately: the pending
      // launch-scoped doc (carries the task/note link) and an id-scoped doc
      // (e.g. one the chat-state observer discovered before the bind reduced).
      // Coalesce instead of throwing — keep the doc that holds the link (default
      // the launch doc, which also owns any automation linkage) and delete the
      // other. The patch below then folds in the incoming chatId/launchId/link.
      const keep = byLaunch.linkedPath || !byChat.linkedPath ? byLaunch : byChat;
      const drop = keep._id === byLaunch._id ? byChat : byLaunch;
      await ctx.db.delete(drop._id);
      existing = keep;
    }

    if (existing) {
      const nextLinkedType =
        "linkedType" in link ? link.linkedType : existing.linkedType;
      const nextLinkedPath =
        "linkedPath" in link ? link.linkedPath : existing.linkedPath;
      await ctx.db.patch(existing._id, {
        launchId: args.launchId ?? existing.launchId,
        chatId: args.chatId ?? existing.chatId,
        pending: args.pending ?? (args.chatId ? false : existing.pending),
        status: args.status,
        title: normalizeTitle(args.title ?? existing.title, args.harness),
        cwd: args.cwd,
        host: args.host,
        environment: args.environment ?? existing.environment,
        linkedType: nextLinkedType,
        linkedPath: nextLinkedPath,
        resumeKind: args.resumeKind ?? existing.resumeKind,
        resumePayload: args.resumePayload ?? existing.resumePayload,
        observedStatus: args.observedStatus ?? existing.observedStatus,
        observedExistence: args.observedExistence ?? existing.observedExistence,
        observedActivity: args.observedActivity ?? existing.observedActivity,
        observedSource: args.observedSource ?? existing.observedSource,
        observedAt: args.observedAt ?? existing.observedAt,
        lastEventAt: args.lastEventAt,
        lastStatusAt: args.lastStatusAt ?? args.lastEventAt,
        endedAt: args.endedAt ?? existing.endedAt,
        updatedAt: now,
      });
      if (args.launchId && isSettledStatus(args.status)) {
        await markAutomationRunSettledForLaunch(ctx, {
          projectId: project._id,
          launchId: args.launchId,
          automationRunId: args.automationRunId,
          linkedType: nextLinkedType,
          linkedPath: nextLinkedPath,
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
      observedStatus: args.observedStatus,
      observedExistence: args.observedExistence,
      observedActivity: args.observedActivity,
      observedSource: args.observedSource,
      observedAt: args.observedAt,
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
        automationRunId: args.automationRunId,
        linkedType: link.linkedType,
        linkedPath: link.linkedPath,
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
