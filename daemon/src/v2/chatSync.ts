// V2 chat-state relay (daemon → server sink).
//
// The chat-state observer writes discovered chat state into the shared
// chatLifecycleStore (the same store V1 uses). This module is the V2 sink: it
// drains server-dirty rows and mirrors them onto the server's `chats` table —
// POST for a row we've never synced, PATCH for one we have. The local↔server id
// mapping lives on the store row (`server_chat_id`, added additively in
// Decision 7), so no separate map table is needed.
//
// Single-creator rule (PRD): chats are DAEMON-created. This is the only place
// the V2 daemon creates/updates chat rows.
//
// The store status vocabulary (working | needs-input | waiting | idle, plus an
// endedAt timestamp) is mapped to the server's chat_status enum
// (busy | waiting_input | idle | dead) by `mapChatStatus`.

import type {
  ChatLifecycleStatus,
  LocalChatRow,
} from "../chatLifecycleStore.js";
import type { ChatLifecycleStore } from "../chatLifecycleStore.js";
import type { HitchClient } from "./serverClient.js";

export type ServerChatStatus = "busy" | "waiting_input" | "idle" | "dead";
export type ServerHarness = "claude" | "codex";

// Matches the server's `z.json()` shape for the cmux_ref column. Kept explicit
// (not Record<string, unknown>) so the hono client's typed `json` input accepts
// it without a cast.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export interface ChatSyncLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface ChatSyncOptions {
  store: ChatLifecycleStore;
  client: HitchClient;
  machineId: string;
  logger: ChatSyncLogger;
}

export interface ChatSyncResult {
  created: number;
  updated: number;
  failed: number;
}

// Store status → server chat_status. endedAt takes precedence: a settled chat
// is `dead` regardless of the last activity status the store recorded.
export function mapChatStatus(chat: {
  status: ChatLifecycleStatus;
  endedAt: number | null;
}): ServerChatStatus {
  if (chat.endedAt != null) return "dead";
  switch (chat.status) {
    case "working":
      return "busy";
    case "needs-input":
      return "waiting_input";
    case "waiting":
      return "waiting_input";
    case "idle":
      return "idle";
  }
}

// Store harness ("claude-code" | "codex") → server harness ("claude" | "codex").
export function mapHarness(harness: LocalChatRow["harness"]): ServerHarness {
  return harness === "codex" ? "codex" : "claude";
}

function titleFor(chat: LocalChatRow): string {
  const title = chat.title?.trim();
  if (title) return title;
  return chat.harness === "codex" ? "Codex chat" : "Claude chat";
}

// The free-form jsonb we stash on the server chat row so a later reconciler /
// focus relay can re-address this chat in cmux. Carries the identifying refs the
// store knows about (session id, launch id, cwd, host, environment, and any
// surface/workspace cmux stamped into resumePayload).
function cmuxRefFor(chat: LocalChatRow): JsonObject {
  const payload = chat.resumePayload ?? {};
  const asString = (value: unknown): string | null =>
    typeof value === "string" ? value : null;
  return {
    localKey: chat.localKey,
    sessionId: chat.chatId,
    launchId: chat.launchId,
    cwd: chat.cwd,
    host: chat.host,
    environment: chat.environment,
    resumeKind: chat.resumeKind,
    surface: asString(payload.surface),
    workspace: asString(payload.workspace),
  };
}

export class ChatSync {
  private readonly store: ChatLifecycleStore;
  private readonly client: HitchClient;
  private readonly machineId: string;
  private readonly logger: ChatSyncLogger;

  constructor(options: ChatSyncOptions) {
    this.store = options.store;
    this.client = options.client;
    this.machineId = options.machineId;
    this.logger = options.logger;
  }

  // Push every server-dirty chat. POST for a row with no server id yet, PATCH
  // otherwise (with a POST fallback if the server row was deleted out from under
  // us — 404). Each success marks the row server-synced at its read-time
  // `updatedAt`, so a change that lands mid-round-trip re-dirties for next tick.
  async sync(limit = 100): Promise<ChatSyncResult> {
    const dirty = this.store.listServerDirtyChats(limit);
    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const chat of dirty) {
      const status = mapChatStatus(chat);
      const cmuxRef = cmuxRefFor(chat);
      const title = titleFor(chat);
      const projectId = chat.projectId ?? null;
      const lastActivityAt = new Date(chat.lastStatusAt).toISOString();
      const syncedAt = chat.updatedAt;

      try {
        let serverChatId = chat.serverChatId;

        if (serverChatId) {
          const res = await this.client.daemon.chats[":id"].$patch({
            param: { id: serverChatId },
            json: { projectId, harness: mapHarness(chat.harness), title, cmuxRef, status, lastActivityAt },
          });
          if (res.ok) {
            this.store.markChatServerSynced(chat.localKey, { syncedAt });
            updated += 1;
            continue;
          }
          if (res.status === 404) {
            // Server row is gone — fall through and recreate it.
            serverChatId = null;
          } else {
            const detail = await res.text().catch(() => "");
            this.logger.error?.(
              `[hitch] chat PATCH failed (${res.status}${detail ? `: ${detail}` : ""}) for ${chat.localKey}`,
            );
            failed += 1;
            continue;
          }
        }

        const res = await this.client.daemon.chats.$post({
          json: {
            machineId: this.machineId,
            projectId,
            harness: mapHarness(chat.harness),
            title,
            cmuxRef,
            status,
            lastActivityAt,
          },
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          this.logger.error?.(
            `[hitch] chat POST failed (${res.status}${detail ? `: ${detail}` : ""}) for ${chat.localKey}`,
          );
          failed += 1;
          continue;
        }
        const row = (await res.json()) as { id: string };
        this.store.markChatServerSynced(chat.localKey, { serverChatId: row.id, syncedAt });
        created += 1;
      } catch (error) {
        this.logger.error?.(`[hitch] chat sync error for ${chat.localKey}: ${String(error)}`);
        failed += 1;
      }
    }

    return { created, updated, failed };
  }
}
