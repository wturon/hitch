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

  // Manual Backlog ordering for the Todos list (todos-v1). Pure UI state, one
  // row per project: an ordered list of task rel-paths, front = top of backlog.
  // Isolated in its own table (not a `projects` field) so a reorder write never
  // re-renders everything subscribed to the project doc. Lossy against the
  // filesystem by design — agents never need it, and read-time reconciliation
  // (lib/todos.ts sortBacklog) prunes stale paths and appends unlisted tasks.
  backlogOrders: defineTable({
    projectId: v.id("projects"),
    order: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // Derived read model for synced `.hitch/automations/<slug>/index.md`
  // definitions. The markdown file remains the editable source of truth; this
  // table stores normalized frontmatter and schedule state for UI/scheduler
  // reads.
  automations: defineTable({
    projectId: v.id("projects"),
    automationPath: v.string(),
    name: v.string(),
    enabled: v.boolean(),
    schedule: v.string(),
    scheduleDescription: v.string(),
    timezone: v.string(),
    harness: v.string(),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    prompt: v.string(),
    lastScheduledAt: v.optional(v.number()),
    nextRunAt: v.optional(v.number()),
    lastRunId: v.optional(v.string()),
    validationError: v.optional(v.string()),
    deleted: v.boolean(),
    sourceUpdatedAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_key", ["projectId", "automationPath"])
    .index("by_project_enabled_next_run", [
      "projectId",
      "enabled",
      "nextRunAt",
    ])
    .index("by_enabled_next_run", [
      "enabled",
      "nextRunAt",
    ]),

  automationRuns: defineTable({
    projectId: v.id("projects"),
    automationId: v.id("automations"),
    automationPath: v.string(),
    trigger: v.union(v.literal("schedule"), v.literal("manual")),
    scheduledFor: v.number(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    commandId: v.optional(v.id("commands")),
    chatId: v.optional(v.id("chats")),
    launchId: v.optional(v.string()),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("skipped"),
    ),
    skipReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_automation", ["automationId"])
    .index("by_automation_status", ["automationId", "status"])
    .index("by_command", ["commandId"])
    .index("by_launch", ["launchId"]),

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

  // Derived index of the agent skills installed on each machine (e.g.
  // ~/.claude/skills/<name>/SKILL.md). The filesystem is the source of truth;
  // the daemon scans skill directories on startup + on an interval and replaces
  // this table's rows for its (projectId, host). The editor's slash menu reads
  // it so users can autocomplete `/skill-name` into task/note bodies. One row
  // per (project, host, skill-name); a skill installed for multiple harnesses is
  // ONE row with several `installs`. Global skills get a row in every hitched
  // project on that host.
  skills: defineTable({
    projectId: v.id("projects"),
    host: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    installs: v.array(
      v.object({
        harness: v.string(), // "claude-code" | "codex"
        scope: v.union(v.literal("global"), v.literal("project")),
        path: v.string(),
      }),
    ),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_key", ["projectId", "host", "name"]),

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
    automationRunId: v.optional(v.id("automationRuns")),
    sessionId: v.optional(v.string()), // the chat to resume; unset for start-chat
    path: v.optional(v.string()), // start-chat: the task's rel path (dedup)
    linkedType: v.optional(
      v.union(v.literal("task"), v.literal("note"), v.literal("automation")),
    ),
    linkedPath: v.optional(v.string()),
    initialPrompt: v.optional(v.string()), // start-chat: seed prompt for the new session
    title: v.optional(v.string()), // start-chat: Hitch display placeholder
    cwd: v.optional(v.string()),
    model: v.optional(v.string()), // start-chat: model to launch (kickoff only)
    effort: v.optional(v.string()), // start-chat: reasoning/effort level (kickoff only)
    status: v.string(), // "pending" | "done" | "error" | "expired"
    statusReason: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    claimedBy: v.optional(v.string()),
    result: v.optional(v.string()), // "focused"/"spawned" or an error message
    errorCode: v.optional(v.string()), // machine-readable failure kind, e.g. "cmux-access-denied"
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_status", ["projectId", "status"])
    .index("by_project_status_expires", ["projectId", "status", "expiresAt"])
    .index("by_status_expires", ["status", "expiresAt"]),

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
    linkedType: v.optional(
      v.union(v.literal("task"), v.literal("note"), v.literal("automation")),
    ),
    linkedPath: v.optional(v.string()),
    resumeKind: v.union(v.literal("open-chat-command"), v.literal("external")),
    resumePayload: v.optional(v.any()),
    // Shadow state from the level-triggered chat-state observer, written
    // alongside the hook-derived `status` while the observer runs dark (P0–P3).
    // Lets the UI/debug surface compare the two sources before the flip (P2).
    observedStatus: v.optional(
      v.union(
        v.literal("working"),
        v.literal("needs-input"),
        v.literal("waiting"),
        v.literal("idle"),
      ),
    ),
    observedExistence: v.optional(
      v.union(v.literal("running"), v.literal("dormant"), v.literal("gone")),
    ),
    observedActivity: v.optional(
      v.union(v.literal("working"), v.literal("idle"), v.literal("unknown")),
    ),
    observedSource: v.optional(v.string()),
    observedAt: v.optional(v.number()),
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
    .index("by_project_chat", ["projectId", "harness", "chatId", "host"])
    .index("by_link", ["projectId", "linkedType", "linkedPath"]),
});
