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
  // Rows the sink permanently declined to relay this round (legacy/unrepresentable
  // — see `isRepresentable`, or a non-retryable 4xx). Marked server-synced so a
  // 400 never storms: they leave `listServerDirtyChats` and don't retry forever.
  skipped: number;
}

// The server keys `chats.projectId` as a server UUID (nullable). A local row
// carrying a NON-UUID projectId is a legacy V1 chat whose projectId is a Convex
// document id (e.g. "m17brnqs30pyevfc05dp3r3x4s87z3an") — the server's
// `chatCreate` validator rejects it with a 400, and because a failed push never
// clears the server cursor the row re-POSTs (and re-400s) every single sync
// round. On a real machine that's ~720 legacy chats storming the server forever.
//
// Such rows can't be faithfully represented (their project doesn't exist on the
// server), so the sink SKIPS them permanently rather than relay them project-less
// or storm 400s. A null projectId is representable (the column is nullable); a
// UUID projectId is a real V2 chat.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRepresentable(chat: Pick<LocalChatRow, "projectId">): boolean {
  return chat.projectId == null || UUID_RE.test(chat.projectId);
}

// A server response that will NOT change on retry, so the row is permanently
// skipped instead of re-pushed forever. Validation (400/422) and conflict (409)
// are non-retryable; 401/403 (a rotated key), 404 (handled separately on PATCH),
// and 408/429 (transient) stay retryable and are NOT treated as permanent.
export function isPermanentReject(status: number): boolean {
  if (status < 400 || status >= 500) return false;
  return status !== 401 && status !== 403 && status !== 404 && status !== 408 && status !== 429;
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
    let skipped = 0;

    for (const chat of dirty) {
      // Legacy/unrepresentable rows (Convex-id projectId) never touch the wire:
      // mark them server-synced so they leave the dirty set and never storm the
      // server with 400s. A settled legacy chat never re-dirties; if one somehow
      // updates it just re-skips here — still zero network.
      if (!isRepresentable(chat)) {
        this.store.markChatServerSynced(chat.localKey, { syncedAt: chat.updatedAt });
        skipped += 1;
        continue;
      }

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
          } else if (isPermanentReject(res.status)) {
            const detail = await res.text().catch(() => "");
            this.logger.error?.(
              `[hitch] chat PATCH rejected (${res.status}${detail ? `: ${detail}` : ""}) for ${chat.localKey} — skipping permanently`,
            );
            this.store.markChatServerSynced(chat.localKey, { syncedAt });
            skipped += 1;
            continue;
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
          if (isPermanentReject(res.status)) {
            this.logger.error?.(
              `[hitch] chat POST rejected (${res.status}${detail ? `: ${detail}` : ""}) for ${chat.localKey} — skipping permanently`,
            );
            this.store.markChatServerSynced(chat.localKey, { syncedAt });
            skipped += 1;
            continue;
          }
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

    return { created, updated, failed, skipped };
  }
}
