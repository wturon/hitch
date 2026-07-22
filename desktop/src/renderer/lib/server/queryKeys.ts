// Server table → TanStack Query key. Deliberately coarse (one key per table):
// a WS invalidation just means "refetch anything derived from this table".
// task_tags maps onto ["tasks"] because task lists embed tagIds — there is no
// separate task_tags query to invalidate.
export const TABLE_QUERY_KEYS: Record<string, readonly [string]> = {
  projects: ["projects"],
  sections: ["sections"],
  tasks: ["tasks"],
  task_tags: ["tasks"],
  tags: ["tags"],
  comments: ["comments"],
  attachments: ["attachments"],
  assignments: ["assignments"],
  chats: ["chats"],
  machines: ["machines"],
};

/** The query key a WS invalidation for `table` maps to; null for unknown tables. */
export function queryKeyForTable(table: string): readonly [string] | null {
  return TABLE_QUERY_KEYS[table] ?? null;
}
