// The local chat registry — what's LEFT of it.
//
// docs/chat-tracking-redesign.md §6 replaced the observation half of this store
// with a spool directory + cursors.json (see daemon/src/observer/spool.ts and
// cursors.ts). Gone from here: the `chat_events` ledger, the reducer and its
// cursor, `observed_files`, `recordObservation`, `listLiveTrackedChats`, and the
// observer shadow columns. Nothing observes through this file any more.
//
// What survives, and why:
//   - `local_chats` + getLocalChat / upsertLocalChat / markChatServerSynced —
//     the V2 RECONCILER still tracks its own launches here and still creates
//     server chats through the legacy POST /daemon/chats. Migrating it onto the
//     snapshot is the next phase; until then this is its working memory.
//   - `cmux_trace` — a local-only debug record of what Hitch asked cmux to do.
//     Launch/focus machinery, not observation.
//
// The store is no longer on the hot path: hooks don't open it (they write one
// JSON file into the spool), and the observer doesn't touch it at all.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ChatLifecycleStatus = "working" | "needs-input" | "waiting" | "idle";

export type ChatLifecycleHarness = "codex" | "claude-code";

export interface LocalChatInput {
  localKey: string;
  projectId: string | null;
  launchId: string | null;
  harness: ChatLifecycleHarness;
  chatId: string | null;
  pending: boolean;
  status: ChatLifecycleStatus;
  title: string;
  cwd: string;
  host: string;
  environment: string | null;
  resumeKind: "open-chat-command" | "external";
  resumePayload?: Record<string, unknown>;
  firstObservedAt: number;
  lastEventAt: number;
  lastStatusAt: number;
  endedAt: number | null;
  pinned?: boolean;
  pinnedAt?: number | null;
  archivedAt?: number | null;
  deletedAt?: number | null;
  updatedAt: number;
}

export interface LocalChatRow extends Required<Omit<LocalChatInput, "resumePayload">> {
  resumePayload: Record<string, unknown>;
  // `serverChatId` is the server `chats.id` this local row maps to;
  // `serverSyncedAt` records the `updatedAt` value last pushed there.
  serverSyncedAt: number | null;
  serverChatId: string | null;
}

// Raw cmux command/response trace. Local-only, never synced: a debug record of
// what Hitch asked cmux to do (and how it responded) so a resume that focused
// the wrong surface can be replayed. `chatId` is the session/thread id when
// known; codex launches only know their `launchId` until the thread binds, so a
// per-chat view ORs on both.
export interface CmuxTraceInput {
  ts: number;
  chatId: string | null;
  launchId: string | null;
  kind: "io" | "decision" | "warn";
  command: string | null;
  args: string[] | null;
  durationMs: number | null;
  ok: boolean | null;
  errorCode: string | null;
  message: string | null;
}

export interface ChatLifecyclePaths {
  appSupportDir: string;
  databasePath: string;
}

export interface ChatLifecycleStoreOptions {
  appSupportDir?: string;
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
}

const SCHEMA_VERSION = 1;
// cmux trace is high-volume debug data, hard-capped by row count on write.
const CMUX_TRACE_MAX_ROWS = 5000;
// How often (in writes) to enforce the row cap, so we don't DELETE on every call.
const CMUX_TRACE_CAP_EVERY = 250;
// One-time cleanup marker: the V3 rework left `chat_events` and `observed_files`
// behind with nothing reading them (10.8 MB of dev data on the author's machine).
const V3_CLEANUP_KEY = "v3_observation_tables_dropped";

function appSupportDirFromEnv(env: NodeJS.ProcessEnv): string {
  if (env.HITCH_APP_SUPPORT_DIR) return resolve(env.HITCH_APP_SUPPORT_DIR);
  if (env.HITCH_CONFIG_PATH) return dirname(resolve(env.HITCH_CONFIG_PATH));

  if (process.platform === "darwin") {
    const appName = env.HITCH_ROOT ? "Hitch Dev" : "Hitch";
    return join(homedir(), "Library/Application Support", appName);
  }
  return join(homedir(), ".config", "hitch");
}

export function resolveChatLifecyclePaths(
  options: ChatLifecycleStoreOptions = {},
): ChatLifecyclePaths {
  const env = options.env ?? process.env;
  const appSupportDir = resolve(options.appSupportDir ?? appSupportDirFromEnv(env));
  return {
    appSupportDir,
    databasePath: resolve(
      options.databasePath ?? join(appSupportDir, "chat-lifecycle.sqlite"),
    ),
  };
}

function numberFromSqlite(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function jsonString(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function jsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

function booleanInt(value: boolean | undefined, fallback: boolean): number {
  return value ?? fallback ? 1 : 0;
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function runInTransaction(db: DatabaseSync, fn: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    fn();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export class ChatLifecycleStore {
  readonly paths: ChatLifecyclePaths;
  private readonly db: DatabaseSync;
  private cmuxTraceWrites = 0;

  constructor(options: ChatLifecycleStoreOptions = {}) {
    this.paths = resolveChatLifecyclePaths(options);
    mkdirSync(dirname(this.paths.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.paths.databasePath);
    this.configure();
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getLocalChat(localKey: string): LocalChatRow | null {
    const row = this.db.prepare("SELECT * FROM local_chats WHERE local_key = ?").get(localKey);
    return row ? this.localChatFromRow(row) : null;
  }

  upsertLocalChat(chat: LocalChatInput): void {
    runInTransaction(this.db, () => {
      this.upsertLocalChatUnsafe(chat);
    });
  }

  // Record that this row was pushed to the server up to `syncedAt` (pass the
  // row's `updatedAt` at read time so a concurrent update during the network
  // round-trip re-dirties correctly rather than being lost). `serverChatId`
  // persists the local↔server id mapping; COALESCE keeps a prior mapping when
  // omitted.
  markChatServerSynced(
    localKey: string,
    options: { serverChatId?: string | null; syncedAt?: number } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE local_chats
         SET server_synced_at = ?,
             server_chat_id = COALESCE(?, server_chat_id)
         WHERE local_key = ?`,
      )
      .run(options.syncedAt ?? Date.now(), options.serverChatId ?? null, localKey);
  }

  appendCmuxTrace(event: CmuxTraceInput): void {
    this.db
      .prepare(
        `INSERT INTO cmux_trace (
          ts, chat_id, launch_id, kind, command, args_json,
          duration_ms, ok, error_code, message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts,
        event.chatId,
        event.launchId,
        event.kind,
        event.command,
        event.args ? JSON.stringify(event.args) : null,
        event.durationMs,
        event.ok === null ? null : event.ok ? 1 : 0,
        event.errorCode,
        event.message,
      );

    // Hard row cap, enforced periodically: delete everything older than the
    // newest CMUX_TRACE_MAX_ROWS. The OFFSET subquery yields the cutoff seq (or
    // nothing when under the cap, in which case `<= NULL` deletes nothing).
    if (++this.cmuxTraceWrites % CMUX_TRACE_CAP_EVERY === 0) {
      this.db
        .prepare(
          `DELETE FROM cmux_trace
           WHERE seq <= (
             SELECT seq FROM cmux_trace ORDER BY seq DESC LIMIT 1 OFFSET ?
           )`,
        )
        .run(CMUX_TRACE_MAX_ROWS);
    }
  }

  private configure(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 1000");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private migrate(): void {
    runInTransaction(this.db, () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS local_chats (
          local_key TEXT PRIMARY KEY,
          project_id TEXT,
          launch_id TEXT,
          harness TEXT NOT NULL,
          chat_id TEXT,
          pending INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          title TEXT NOT NULL,
          cwd TEXT NOT NULL,
          host TEXT NOT NULL,
          environment TEXT,
          resume_kind TEXT NOT NULL,
          resume_payload_json TEXT NOT NULL DEFAULT '{}',
          first_observed_at INTEGER NOT NULL,
          last_event_at INTEGER NOT NULL,
          last_status_at INTEGER NOT NULL,
          ended_at INTEGER,
          pinned INTEGER NOT NULL DEFAULT 0,
          pinned_at INTEGER,
          archived_at INTEGER,
          deleted_at INTEGER,
          updated_at INTEGER NOT NULL
        );
        -- Databases created before V1 was removed, and before the V3 rework,
        -- still carry retired columns (the Convex sink's dirty/convex_id, the
        -- observer's observed_* shadow, observer_created). They are left in
        -- place — all have defaults, so INSERTs that omit them still work — and
        -- nothing reads or writes them any more.

        CREATE UNIQUE INDEX IF NOT EXISTS local_chats_by_chat
          ON local_chats(harness, chat_id, host)
          WHERE chat_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS local_chats_by_launch
          ON local_chats(launch_id)
          WHERE launch_id IS NOT NULL;
      `);

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cmux_trace (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER NOT NULL,
          chat_id TEXT,
          launch_id TEXT,
          kind TEXT NOT NULL,
          command TEXT,
          args_json TEXT,
          duration_ms INTEGER,
          ok INTEGER,
          error_code TEXT,
          message TEXT
        );

        CREATE INDEX IF NOT EXISTS cmux_trace_by_chat ON cmux_trace(chat_id, seq);
        CREATE INDEX IF NOT EXISTS cmux_trace_by_launch ON cmux_trace(launch_id, seq);
        CREATE INDEX IF NOT EXISTS cmux_trace_by_ts ON cmux_trace(ts);
      `);

      // Server-sink bookkeeping: the reconciler's local↔server chat id mapping.
      this.addColumnIfMissing("local_chats", "server_synced_at", "server_synced_at INTEGER");
      this.addColumnIfMissing("local_chats", "server_chat_id", "server_chat_id TEXT");

      // One-time V3 cleanup. The event ledger and the tail-cursor table have no
      // reader left; dropping them reclaims the megabytes they'd otherwise keep
      // growing by. Guarded by a meta flag so it runs once, and DROP IF EXISTS
      // so a database that never had them is untouched.
      if (this.getMetaUnsafe(V3_CLEANUP_KEY) === null) {
        this.db.exec(`
          DROP TABLE IF EXISTS chat_events;
          DROP TABLE IF EXISTS observed_files;
        `);
        this.setMeta(V3_CLEANUP_KEY, String(Date.now()));
      }

      this.db
        .prepare(
          `INSERT INTO meta (key, value)
           VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(SCHEMA_VERSION));
    });
  }

  // `getMeta` inside migrate(), before the public API is safe to use.
  private getMetaUnsafe(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  // Idempotent column add. `table`/`ddl` are internal constants (never user
  // input), so the interpolation is safe. PRAGMA table_info is the portable way
  // to ask "does this column exist yet" without a try/catch on the ALTER.
  private addColumnIfMissing(table: string, column: string, ddl: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }

  private upsertLocalChatUnsafe(chat: LocalChatInput): void {
    // Guarantee a single owner of this launch_id before the upsert — the
    // partial unique index local_chats_by_launch rejects a second holder.
    if (chat.launchId) {
      const targetExists =
        this.db.prepare("SELECT 1 FROM local_chats WHERE local_key = ?").get(chat.localKey) !==
        undefined;
      if (targetExists) {
        // The destination row already exists (a bind folding a launch into a
        // chat row). Any OTHER row still holding this launch_id — the pending
        // launch:<id> row — has had its link fields merged upstream, so drop it:
        // keeping it would collide on the unique launch_id index.
        this.db
          .prepare("DELETE FROM local_chats WHERE launch_id = ? AND local_key != ?")
          .run(chat.launchId, chat.localKey);
      } else {
        // No destination row yet: rekey the existing launch:<id> row so the
        // upsert updates it in place (pending → bound) rather than inserting a
        // duplicate that would collide on launch_id.
        this.db
          .prepare("UPDATE local_chats SET local_key = ? WHERE launch_id = ? AND local_key != ?")
          .run(chat.localKey, chat.launchId, chat.localKey);
      }
    }

    this.db
      .prepare(
        `INSERT INTO local_chats (
          local_key, project_id, launch_id, harness, chat_id, pending, status,
          title, cwd, host, environment, resume_kind, resume_payload_json,
          first_observed_at, last_event_at, last_status_at, ended_at,
          pinned, pinned_at, archived_at, deleted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_key) DO UPDATE SET
          project_id = excluded.project_id,
          launch_id = excluded.launch_id,
          harness = excluded.harness,
          chat_id = excluded.chat_id,
          pending = excluded.pending,
          status = excluded.status,
          title = excluded.title,
          cwd = excluded.cwd,
          host = excluded.host,
          environment = excluded.environment,
          resume_kind = excluded.resume_kind,
          resume_payload_json = excluded.resume_payload_json,
          first_observed_at = excluded.first_observed_at,
          last_event_at = excluded.last_event_at,
          last_status_at = excluded.last_status_at,
          ended_at = excluded.ended_at,
          pinned = excluded.pinned,
          pinned_at = excluded.pinned_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        chat.localKey,
        chat.projectId,
        chat.launchId,
        chat.harness,
        chat.chatId,
        booleanInt(chat.pending, false),
        chat.status,
        chat.title,
        chat.cwd,
        chat.host,
        chat.environment,
        chat.resumeKind,
        jsonString(chat.resumePayload),
        chat.firstObservedAt,
        chat.lastEventAt,
        chat.lastStatusAt,
        chat.endedAt,
        booleanInt(chat.pinned, false),
        chat.pinnedAt ?? null,
        chat.archivedAt ?? null,
        chat.deletedAt ?? null,
        chat.updatedAt,
      );
  }

  private localChatFromRow(row: unknown): LocalChatRow {
    const value = row as Record<string, unknown>;
    return {
      localKey: String(value.local_key),
      projectId: value.project_id === null ? null : String(value.project_id),
      launchId: value.launch_id === null ? null : String(value.launch_id),
      harness: String(value.harness) as ChatLifecycleHarness,
      chatId: value.chat_id === null ? null : String(value.chat_id),
      pending: bool(value.pending),
      status: String(value.status) as ChatLifecycleStatus,
      title: String(value.title),
      cwd: String(value.cwd),
      host: String(value.host),
      environment: value.environment === null ? null : String(value.environment),
      resumeKind: String(value.resume_kind) as "open-chat-command" | "external",
      resumePayload: jsonObject(String(value.resume_payload_json)),
      firstObservedAt: numberFromSqlite(value.first_observed_at),
      lastEventAt: numberFromSqlite(value.last_event_at),
      lastStatusAt: numberFromSqlite(value.last_status_at),
      endedAt: value.ended_at === null ? null : numberFromSqlite(value.ended_at),
      pinned: bool(value.pinned),
      pinnedAt: value.pinned_at === null ? null : numberFromSqlite(value.pinned_at),
      archivedAt: value.archived_at === null ? null : numberFromSqlite(value.archived_at),
      deletedAt: value.deleted_at === null ? null : numberFromSqlite(value.deleted_at),
      updatedAt: numberFromSqlite(value.updated_at),
      serverSyncedAt:
        value.server_synced_at == null ? null : numberFromSqlite(value.server_synced_at),
      serverChatId: value.server_chat_id == null ? null : String(value.server_chat_id),
    };
  }
}

export function openChatLifecycleStore(
  options: ChatLifecycleStoreOptions = {},
): ChatLifecycleStore {
  return new ChatLifecycleStore(options);
}
