// Server table → TanStack Query keys. Deliberately coarse: a WS invalidation
// just means "refetch anything derived from this table". A table maps to SEVERAL
// keys when its rows are embedded in another table's reads — task_tags lands on
// ["tasks"] because task lists embed tagIds, and there is no separate task_tags
// query to invalidate.
export const TABLE_QUERY_KEYS: Record<string, readonly string[]> = {
  projects: ["projects"],
  sections: ["sections"],
  tasks: ["tasks"],
  task_tags: ["tasks"],
  tags: ["tags"],
  comments: ["comments"],
  attachments: ["attachments"],
  // GET /chats denormalises the task each chat is committed to (routes/chats.ts,
  // "Attachment 1"), and that fact lives in ASSIGNMENTS — it changes with no
  // write to the chats table at all, both when a chat is linked and when the
  // daemon confirms the adoption. Without ["chats"] here, the "Link a chat"
  // picker keeps offering a chat that is already spoken for until something
  // unrelated happens to refetch it.
  assignments: ["assignments", "chats"],
  chats: ["chats"],
  // Relayed hook events hang off a chat and are only ever read alongside one,
  // so they invalidate the chat queries rather than owning a key.
  chat_events: ["chats"],
  machines: ["machines"],
};

/** The query keys a WS invalidation for `table` maps to; null for unknown tables. */
export function queryKeysForTable(table: string): readonly string[] | null {
  return TABLE_QUERY_KEYS[table] ?? null;
}
