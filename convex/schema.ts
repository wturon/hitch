import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,

  projects: defineTable({
    name: v.string(),
    statuses: v.optional(
      v.array(
        v.object({
          id: v.string(),
          name: v.string(),
        }),
      ),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_created_by", ["createdBy"]),

  projectMembers: defineTable({
    projectId: v.id("projects"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("member")),
    createdAt: v.number(),
    // Per-user sidebar pinning (synced across the user's devices). `pinned`
    // surfaces the project in the PINNED group; `pinnedOrder` is the manual
    // drag-ordered position within it (lower = higher in the list).
    pinned: v.optional(v.boolean()),
    pinnedOrder: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"])
    .index("by_project_user", ["projectId", "userId"]),

  deviceTokens: defineTable({
    userId: v.id("users"),
    deviceId: v.optional(v.string()),
    name: v.string(),
    hostname: v.optional(v.string()),
    tokenHash: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_user_device", ["userId", "deviceId"])
    .index("by_token_hash", ["tokenHash"]),

  // One row per file in a project's .hitch/ folder.
  // Unique key is (projectId, path), where path is relative to .hitch/.
  files: defineTable({
    projectId: v.id("projects"),
    path: v.string(),
    content: v.string(),
    hash: v.string(),
    deleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_key", ["projectId", "path"]),

  // One row per image attachment in a task folder. Unlike `files`, the bytes
  // live in Convex file storage (blobs), not in a text column — base64 in a
  // ~1 MiB document would blow up on typical screenshots. `path` is relative to
  // .hitch/ (e.g. tasks/<slug>/attachments/image-1.png) and IS the join key the
  // markdown reference resolves to. The daemon is download-only: it materializes
  // these blobs to local disk and removes them on tombstone.
  attachments: defineTable({
    projectId: v.id("projects"),
    path: v.string(),
    storageId: v.id("_storage"),
    hash: v.string(),
    contentType: v.string(),
    size: v.number(),
    deleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_key", ["projectId", "path"]),

  // One row per running daemon (keyed by machine). Lets the board show which
  // machines are connected and when they were last seen.
  daemons: defineTable({
    projectId: v.id("projects"),
    hostname: v.string(),
    lastSeen: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_key", ["projectId", "hostname"]),

  // A queue of actions for daemons to run on the local machine — things the
  // browser can't do itself, like opening a terminal. The desktop UI enqueues a
  // command; the matching daemon (by project, optionally pinned to a host)
  // picks it up via a reactive query, runs it, and marks it done.
  commands: defineTable({
    projectId: v.id("projects"),
    host: v.optional(v.string()), // target machine; unset = any daemon for the project
    kind: v.string(), // "open-chat" (resume existing) | "start-chat" (spawn fresh)
    harness: v.string(), // "claude-code" | "codex"
    launchId: v.optional(v.string()), // start-chat: pending chat row correlation id
    sessionId: v.optional(v.string()), // the chat to resume; unset for start-chat
    path: v.optional(v.string()), // start-chat: the task's rel path (dedup)
    linkedType: v.optional(v.union(v.literal("task"), v.literal("note"))),
    linkedPath: v.optional(v.string()),
    initialPrompt: v.optional(v.string()), // start-chat: seed prompt for the new session
    cwd: v.optional(v.string()),
    model: v.optional(v.string()), // start-chat: model to launch (kickoff only)
    effort: v.optional(v.string()), // start-chat: reasoning/effort level (kickoff only)
    status: v.string(), // "pending" | "done" | "error"
    result: v.optional(v.string()), // "focused"/"spawned" or an error message
    errorCode: v.optional(v.string()), // machine-readable failure kind, e.g. "cmux-access-denied"
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_status", ["projectId", "status"]),

  // Synced chat registry rows reduced from local lifecycle observations. Hitch
  // tracks metadata and resume handles; harnesses still own transcripts.
  chats: defineTable({
    projectId: v.id("projects"),
    launchId: v.optional(v.string()),
    harness: v.union(v.literal("claude-code"), v.literal("codex")),
    chatId: v.optional(v.string()),
    pending: v.boolean(),
    status: v.union(
      v.literal("working"),
      v.literal("needs-input"),
      v.literal("waiting"),
      v.literal("idle"),
    ),
    title: v.string(),
    cwd: v.string(),
    host: v.string(),
    environment: v.optional(
      v.union(
        v.literal("cmux"),
        v.literal("codex-app"),
        v.literal("vscode"),
        v.literal("cursor"),
        v.literal("t3code"),
      ),
    ),
    linkedType: v.optional(v.union(v.literal("task"), v.literal("note"))),
    linkedPath: v.optional(v.string()),
    resumeKind: v.union(v.literal("open-chat-command"), v.literal("external")),
    resumePayload: v.optional(v.any()),
    firstObservedAt: v.number(),
    lastEventAt: v.number(),
    lastStatusAt: v.number(),
    endedAt: v.optional(v.number()),
    pinned: v.optional(v.boolean()),
    pinnedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_status", ["projectId", "status"])
    .index("by_project_updated", ["projectId", "updatedAt"])
    .index("by_project_pinned", ["projectId", "pinned", "pinnedAt"])
    .index("by_project_archived", ["projectId", "archivedAt"])
    .index("by_project_launch", ["projectId", "launchId"])
    .index("by_project_chat", ["projectId", "harness", "chatId", "host"]),
});
