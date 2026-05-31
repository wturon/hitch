import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // One row per file in a watched .hitch/ folder.
  // Unique key is (workspace, source, path):
  //   workspace — groups everything into one board
  //   source    — label of the watched root (e.g. a repo), so files from
  //               different repos don't collide on the same relative path
  //   path      — path relative to that root's .hitch/ folder
  files: defineTable({
    workspace: v.string(),
    source: v.string(),
    path: v.string(),
    content: v.string(),
    hash: v.string(),
    deleted: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_key", ["workspace", "source", "path"]),

  // One row per running daemon (keyed by machine). Lets the board show which
  // machines are connected, what they're watching, and when they were last
  // seen — sync health without needing a desktop app.
  daemons: defineTable({
    workspace: v.string(),
    hostname: v.string(),
    sources: v.array(v.string()),
    lastSeen: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_key", ["workspace", "hostname"]),

  // A queue of actions for daemons to run on the local machine — things the
  // browser can't do itself, like opening a terminal. The web UI enqueues a
  // command; the matching daemon (by workspace, optionally pinned to a host)
  // picks it up via a reactive query, runs it, and marks it done.
  commands: defineTable({
    workspace: v.string(),
    host: v.optional(v.string()), // target machine; unset = any daemon for the workspace
    kind: v.string(), // "open-chat" (resume existing) | "start-chat" (spawn fresh)
    harness: v.string(), // "claude-code" | "codex"
    sessionId: v.optional(v.string()), // the chat to resume; unset for start-chat
    source: v.optional(v.string()), // start-chat: the task's root label (→ cwd, dedup)
    path: v.optional(v.string()), // start-chat: the task's rel path (dedup)
    initialPrompt: v.optional(v.string()), // start-chat: seed prompt for the new session
    cwd: v.optional(v.string()),
    status: v.string(), // "pending" | "done" | "error"
    result: v.optional(v.string()), // "focused"/"spawned" or an error message
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspace"])
    .index("by_workspace_status", ["workspace", "status"]),
});
