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
  // browser can't do itself, like opening a terminal. The web UI enqueues a
  // command; the matching daemon (by project, optionally pinned to a host)
  // picks it up via a reactive query, runs it, and marks it done.
  commands: defineTable({
    projectId: v.id("projects"),
    host: v.optional(v.string()), // target machine; unset = any daemon for the project
    kind: v.string(), // "open-chat" (resume existing) | "start-chat" (spawn fresh)
    harness: v.string(), // "claude-code" | "codex"
    sessionId: v.optional(v.string()), // the chat to resume; unset for start-chat
    path: v.optional(v.string()), // start-chat: the task's rel path (dedup)
    initialPrompt: v.optional(v.string()), // start-chat: seed prompt for the new session
    cwd: v.optional(v.string()),
    status: v.string(), // "pending" | "done" | "error"
    result: v.optional(v.string()), // "focused"/"spawned" or an error message
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_status", ["projectId", "status"]),
});
