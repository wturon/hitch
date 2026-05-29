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
});
