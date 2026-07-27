import { and, isNotNull, ne, type SQL } from "drizzle-orm";

import { chats } from "../db/schema.js";

// Session-browser visibility: dormant and aged-out chats remain resumable and
// visible; only an observed death removes one from the live browser.
export const chatIsVisible: SQL = ne(chats.status, "dead");

// Attachment is stricter than visibility. An aged-out chat keeps its historical
// idle status but has no current machine observation, so it cannot safely accept
// new work until it reappears in a snapshot.
export const chatIsAttachable: SQL = and(
  chatIsVisible,
  isNotNull(chats.existence),
) as SQL;
