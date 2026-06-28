import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeChatTitle } from "./chatTitles.js";
import { LINKED_DOC_TYPES_SQL } from "./linkedDocs.js";

export type ChatLifecycleStatus =
  | "working"
  | "needs-input"
  | "waiting"
  | "idle";

export type ChatLifecycleSource = "hook" | "daemon";

export type ChatLifecycleProducer =
  | "codex-hook"
  | "claude-code-hook"
  | "daemon-launch"
  | "daemon-linker"
  | "daemon-appserver"
  | "daemon-reconcile";

export type ChatLifecycleHarness = "codex" | "claude-code";

export type ChatLifecycleKind =
  | "chat.created"
  | "chat.bound"
  | "turn.started"
  | "turn.resumed"
  | "turn.needs_input"
  | "turn.completed"
  | "session.started"
  | "session.ended";

export interface ChatLifecycleEventInput {
  schemaVersion?: 1;
  eventId: string;
  source: ChatLifecycleSource;
  producer: ChatLifecycleProducer;
  harness: ChatLifecycleHarness;
  providerEvent: string;
  lifecycle: ChatLifecycleKind;
  status: ChatLifecycleStatus | null;
  projectId: string | null;
  projectLocalPath: string | null;
  chatId: string | null;
  launchId: string | null;
  turnId: string | null;
  cwd: string;
  host: string;
  observedAt: string | number | Date;
  rawPayloadHash: string | null;
  rawPayloadRef: string | null;
  metadata?: Record<string, unknown>;
}

export interface ChatLifecycleEventRow extends ChatLifecycleEventInput {
  schemaVersion: 1;
  seq: number;
  observedAt: number;
  metadata: Record<string, unknown>;
  reducedAt: number | null;
}

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
  linkedType: "task" | "note" | "automation" | null;
  linkedPath: string | null;
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
  dirty?: boolean;
  lastSyncedAt?: number | null;
  convexId?: string | null;
  updatedAt: number;
}

export interface LocalChatRow extends Required<LocalChatInput> {
  resumePayload: Record<string, unknown>;
}

export interface ChatLifecycleReductionResult {
  eventsReduced: number;
  chatsChanged: number;
  cursor: number;
}

// Raw cmux command/response trace. Unlike lifecycle events, these are NOT
// reduced and never sync to Convex — they're a local-only debug record of what
// Hitch asked cmux to do (and how it responded) so the chat-lifecycle debug
// screen can replay why a resume focused the wrong surface or spawned a dupe.
// `chatId` is the session/thread id when known; codex launches only know their
// `launchId` until the hook binds the thread, so a per-chat view ORs on both.
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

export interface CmuxTraceRow extends CmuxTraceInput {
  seq: number;
}

export interface ChatLifecyclePaths {
  appSupportDir: string;
  databasePath: string;
  bumpPath: string;
}

export interface ChatLifecycleStoreOptions {
  appSupportDir?: string;
  databasePath?: string;
  bumpPath?: string;
  env?: NodeJS.ProcessEnv;
}

const SCHEMA_VERSION = 1;
const REDUCER_CURSOR_KEY = "reducer_cursor";
const DEFAULT_REDUCED_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// cmux trace is high-volume debug data, so it ages out faster than lifecycle
// events (time-based pruneCmuxTrace), AND is hard-capped by row count on write.
// The row cap is what bounds the table while the debug screen polls an idle
// project — pruneCmuxTrace only runs on the reduce cycle, which may not fire.
const DEFAULT_CMUX_TRACE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const CMUX_TRACE_MAX_ROWS = 5000;
// How often (in writes) to enforce the row cap, so we don't run a DELETE on
// every single cmux call.
const CMUX_TRACE_CAP_EVERY = 250;

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
  const appSupportDir = resolve(
    options.appSupportDir ?? appSupportDirFromEnv(env),
  );
  return {
    appSupportDir,
    databasePath: resolve(
      options.databasePath ?? join(appSupportDir, "chat-lifecycle.sqlite"),
    ),
    bumpPath: resolve(
      options.bumpPath ?? join(appSupportDir, "chat-lifecycle.bump"),
    ),
  };
}

function numberFromSqlite(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function timestampFromInput(value: string | number | Date): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid lifecycle timestamp: ${value}`);
  }
  return parsed;
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

function cmuxTraceFromRow(row: unknown): CmuxTraceRow {
  const v = row as Record<string, unknown>;
  const argsJson = v.args_json;
  return {
    seq: numberFromSqlite(v.seq),
    ts: numberFromSqlite(v.ts),
    chatId: (v.chat_id as string | null) ?? null,
    launchId: (v.launch_id as string | null) ?? null,
    kind: v.kind as CmuxTraceInput["kind"],
    command: (v.command as string | null) ?? null,
    args: typeof argsJson === "string" ? (JSON.parse(argsJson) as string[]) : null,
    durationMs: v.duration_ms === null ? null : numberFromSqlite(v.duration_ms),
    ok: v.ok === null ? null : bool(v.ok),
    errorCode: (v.error_code as string | null) ?? null,
    message: (v.message as string | null) ?? null,
  };
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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

  insertLifecycleEvent(
    event: ChatLifecycleEventInput,
  ): { inserted: boolean; seq: number | null } {
    const observedAt = timestampFromInput(event.observedAt);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO chat_events (
          event_id,
          schema_version,
          source,
          producer,
          harness,
          provider_event,
          lifecycle,
          status,
          project_id,
          project_local_path,
          chat_id,
          launch_id,
          turn_id,
          cwd,
          host,
          observed_at,
          raw_payload_hash,
          raw_payload_ref,
          metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.schemaVersion ?? SCHEMA_VERSION,
        event.source,
        event.producer,
        event.harness,
        event.providerEvent,
        event.lifecycle,
        event.status,
        event.projectId,
        event.projectLocalPath,
        event.chatId,
        event.launchId,
        event.turnId,
        event.cwd,
        event.host,
        observedAt,
        event.rawPayloadHash,
        event.rawPayloadRef,
        jsonString(event.metadata),
      );

    if (result.changes === 0) return { inserted: false, seq: null };

    const seq = numberFromSqlite(result.lastInsertRowid);
    this.writeBump(seq);
    return { inserted: true, seq };
  }

  readEventsAfter(cursor: number, limit = 100): ChatLifecycleEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_events
         WHERE seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(cursor, limit)
      .map((row) => this.eventFromRow(row));
  }

  readUnreducedEvents(limit = 100): ChatLifecycleEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM chat_events
         WHERE reduced_at IS NULL
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(limit)
      .map((row) => this.eventFromRow(row));
  }

  markEventsReduced(seqs: number[], reducedAt = Date.now()): void {
    if (seqs.length === 0) return;
    runInTransaction(this.db, () => {
      const stmt = this.db.prepare(
        "UPDATE chat_events SET reduced_at = ? WHERE seq = ?",
      );
      for (const seq of seqs) stmt.run(reducedAt, seq);
    });
  }

  getReducerCursor(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(REDUCER_CURSOR_KEY) as { value?: string } | undefined;
    return row?.value ? Number(row.value) : 0;
  }

  setReducerCursor(cursor: number): void {
    this.setMeta(REDUCER_CURSOR_KEY, String(cursor));
  }

  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value?: string } | undefined;
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

  upsertLocalChat(chat: LocalChatInput): void {
    runInTransaction(this.db, () => {
      this.upsertLocalChatUnsafe(chat);
    });
  }

  reduceLifecycleEvents(
    options: { limit?: number; now?: number } = {},
  ): ChatLifecycleReductionResult {
    const startedCursor = this.getReducerCursor();
    const events = this.readEventsAfter(startedCursor, options.limit ?? 100);
    if (events.length === 0) {
      return { eventsReduced: 0, chatsChanged: 0, cursor: startedCursor };
    }

    const now = options.now ?? Date.now();
    const reducedAt = now;
    let cursor = startedCursor;
    let chatsChanged = 0;

    runInTransaction(this.db, () => {
      for (const event of events) {
        const next = this.reduceEventToLocalChat(event, now);
        if (next) {
          const existing = this.findLocalChatForEvent(event);
          const changed = !existing || !this.sameReducedChat(existing, next);
          this.upsertLocalChatUnsafe({
            ...next,
            dirty: existing?.dirty || changed,
            lastSyncedAt: existing?.lastSyncedAt ?? null,
            convexId: existing?.convexId ?? null,
            updatedAt: changed || !existing ? now : existing.updatedAt,
          });
          if (changed) chatsChanged += 1;
        }

        this.db
          .prepare("UPDATE chat_events SET reduced_at = ? WHERE seq = ?")
          .run(reducedAt, event.seq);
        cursor = event.seq;
        this.db
          .prepare(
            `INSERT INTO meta (key, value)
             VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(REDUCER_CURSOR_KEY, String(cursor));
      }
    });

    return {
      eventsReduced: events.length,
      chatsChanged,
      cursor,
    };
  }

  getLocalChat(localKey: string): LocalChatRow | null {
    const row = this.db
      .prepare("SELECT * FROM local_chats WHERE local_key = ?")
      .get(localKey);
    return row ? this.localChatFromRow(row) : null;
  }

  listDirtyChats(limit = 100): LocalChatRow[] {
    return this.db
      .prepare(
        `SELECT * FROM local_chats
         WHERE dirty = 1
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(limit)
      .map((row) => this.localChatFromRow(row));
  }

  // Chats linked to an editable doc (a task's task.md or a note's index.md),
  // whose frontmatter the daemon keeps stamped/projected. The accepted kinds
  // come from LINKED_DOC_KINDS so this stays in lockstep with the bind/reconcile
  // paths; automations link a path too but aren't projected, so they're excluded.
  listFileLinkedChats(projectId: string, limit = 500): LocalChatRow[] {
    return this.db
      .prepare(
        `SELECT * FROM local_chats
         WHERE project_id = ?
           AND linked_type IN (${LINKED_DOC_TYPES_SQL})
           AND linked_path IS NOT NULL
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(projectId, limit)
      .map((row) => this.localChatFromRow(row));
  }

  // cmux-environment chats for the debug screen, newest activity first. Scoped
  // to a project when given (matches the rest of the app's project context),
  // or all cmux chats when null.
  listCmuxChats(projectId: string | null, limit = 200): LocalChatRow[] {
    const base = `SELECT * FROM local_chats
         WHERE environment = 'cmux'
           AND deleted_at IS NULL`;
    const stmt = projectId
      ? this.db.prepare(
          `${base} AND project_id = ? ORDER BY last_event_at DESC LIMIT ?`,
        )
      : this.db.prepare(`${base} ORDER BY last_event_at DESC LIMIT ?`);
    const rows = projectId ? stmt.all(projectId, limit) : stmt.all(limit);
    return rows.map((row) => this.localChatFromRow(row));
  }

  listChatsForTitleRefresh(
    projectId: string,
    harness: ChatLifecycleHarness,
    limit = 20,
  ): LocalChatRow[] {
    return this.db
      .prepare(
        `SELECT * FROM local_chats
         WHERE project_id = ?
           AND harness = ?
           AND chat_id IS NOT NULL
           AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(projectId, harness, limit)
      .map((row) => this.localChatFromRow(row));
  }

  updateChatTitle(localKey: string, title: string, updatedAt = Date.now()): boolean {
    const existing = this.getLocalChat(localKey);
    if (!existing) return false;
    const normalized = normalizeChatTitle(title, existing.harness);
    if (existing.title === normalized) return false;

    const result = this.db
      .prepare(
        `UPDATE local_chats
         SET title = ?,
             dirty = 1,
             updated_at = ?
         WHERE local_key = ?`,
      )
      .run(normalized, updatedAt, localKey);
    return numberFromSqlite(result.changes) > 0;
  }

  markChatDirty(localKey: string, updatedAt = Date.now()): void {
    this.db
      .prepare(
        "UPDATE local_chats SET dirty = 1, updated_at = ? WHERE local_key = ?",
      )
      .run(updatedAt, localKey);
  }

  markChatSynced(
    localKey: string,
    options: { convexId?: string | null; syncedAt?: number } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE local_chats
         SET dirty = 0,
             last_synced_at = ?,
             convex_id = COALESCE(?, convex_id)
         WHERE local_key = ?`,
      )
      .run(options.syncedAt ?? Date.now(), options.convexId ?? null, localKey);
  }

  cleanupReducedEvents(
    options: { now?: number; retentionMs?: number } = {},
  ): number {
    const cutoff =
      (options.now ?? Date.now()) -
      (options.retentionMs ?? DEFAULT_REDUCED_EVENT_RETENTION_MS);
    const result = this.db
      .prepare(
        `DELETE FROM chat_events
         WHERE reduced_at IS NOT NULL
           AND reduced_at < ?`,
      )
      .run(cutoff);
    return numberFromSqlite(result.changes);
  }

  appendCmuxTrace(event: CmuxTraceInput): void {
    this.db
      .prepare(
        `INSERT INTO cmux_trace (
          ts,
          chat_id,
          launch_id,
          kind,
          command,
          args_json,
          duration_ms,
          ok,
          error_code,
          message
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
    // nothing when under the cap, in which case `<= NULL` deletes nothing). This
    // bounds the table independent of the time-based prune.
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

  // Most-recent trace rows, newest first. With no filter this is the global
  // firehose; pass chatId and/or launchId to scope to one chat (OR-matched, so a
  // codex chat's launch-time rows surface alongside its post-bind rows).
  readCmuxTrace(
    filter: { chatId?: string | null; launchId?: string | null } = {},
    limit = 500,
  ): CmuxTraceRow[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.chatId) {
      clauses.push("chat_id = ?");
      params.push(filter.chatId);
    }
    if (filter.launchId) {
      clauses.push("launch_id = ?");
      params.push(filter.launchId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" OR ")}` : "";
    params.push(limit);
    return this.db
      .prepare(`SELECT * FROM cmux_trace ${where} ORDER BY seq DESC LIMIT ?`)
      .all(...params)
      .map((row) => cmuxTraceFromRow(row));
  }

  pruneCmuxTrace(options: { now?: number; retentionMs?: number } = {}): number {
    const cutoff =
      (options.now ?? Date.now()) -
      (options.retentionMs ?? DEFAULT_CMUX_TRACE_RETENTION_MS);
    const result = this.db
      .prepare(`DELETE FROM cmux_trace WHERE ts < ?`)
      .run(cutoff);
    return numberFromSqlite(result.changes);
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

      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      const version = row?.value ? Number(row.value) : 0;

      if (version < 1) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS chat_events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            schema_version INTEGER NOT NULL,
            source TEXT NOT NULL,
            producer TEXT NOT NULL,
            harness TEXT NOT NULL,
            provider_event TEXT NOT NULL,
            lifecycle TEXT NOT NULL,
            status TEXT,
            project_id TEXT,
            project_local_path TEXT,
            chat_id TEXT,
            launch_id TEXT,
            turn_id TEXT,
            cwd TEXT NOT NULL,
            host TEXT NOT NULL,
            observed_at INTEGER NOT NULL,
            raw_payload_hash TEXT,
            raw_payload_ref TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            reduced_at INTEGER
          );

          CREATE INDEX IF NOT EXISTS chat_events_by_reducer
            ON chat_events(seq)
            WHERE reduced_at IS NULL;
          CREATE INDEX IF NOT EXISTS chat_events_by_chat
            ON chat_events(harness, chat_id, seq);
          CREATE INDEX IF NOT EXISTS chat_events_by_launch
            ON chat_events(launch_id, seq);

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
            linked_type TEXT,
            linked_path TEXT,
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
            dirty INTEGER NOT NULL DEFAULT 1,
            last_synced_at INTEGER,
            convex_id TEXT,
            updated_at INTEGER NOT NULL
          );

          CREATE UNIQUE INDEX IF NOT EXISTS local_chats_by_chat
            ON local_chats(harness, chat_id, host)
            WHERE chat_id IS NOT NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS local_chats_by_launch
            ON local_chats(launch_id)
            WHERE launch_id IS NOT NULL;
        `);
      }

      // Local-only cmux debug trace. Created unconditionally (IF NOT EXISTS)
      // rather than behind the schema_version gate, because SCHEMA_VERSION also
      // stamps lifecycle-event rows — bumping it just to add this side table
      // would mislabel those events.
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

        CREATE INDEX IF NOT EXISTS cmux_trace_by_chat
          ON cmux_trace(chat_id, seq);
        CREATE INDEX IF NOT EXISTS cmux_trace_by_launch
          ON cmux_trace(launch_id, seq);
        CREATE INDEX IF NOT EXISTS cmux_trace_by_ts
          ON cmux_trace(ts);
      `);

      this.db
        .prepare(
          `INSERT INTO meta (key, value)
           VALUES ('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(SCHEMA_VERSION));
    });
  }

  private writeBump(seq: number): void {
    mkdirSync(dirname(this.paths.bumpPath), { recursive: true });
    writeFileSync(this.paths.bumpPath, `${seq}\n`, "utf8");
  }

  private upsertLocalChatUnsafe(chat: LocalChatInput): void {
    if (chat.launchId) {
      this.db
        .prepare(
          `UPDATE local_chats
           SET local_key = ?
           WHERE launch_id = ?
             AND local_key != ?
             AND NOT EXISTS (
               SELECT 1 FROM local_chats AS target
               WHERE target.local_key = ?
             )`,
        )
        .run(chat.localKey, chat.launchId, chat.localKey, chat.localKey);
    }

    this.db
      .prepare(
        `INSERT INTO local_chats (
          local_key,
          project_id,
          launch_id,
          harness,
          chat_id,
          pending,
          status,
          title,
          cwd,
          host,
          environment,
          linked_type,
          linked_path,
          resume_kind,
          resume_payload_json,
          first_observed_at,
          last_event_at,
          last_status_at,
          ended_at,
          pinned,
          pinned_at,
          archived_at,
          deleted_at,
          dirty,
          last_synced_at,
          convex_id,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          linked_type = excluded.linked_type,
          linked_path = excluded.linked_path,
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
          dirty = excluded.dirty,
          last_synced_at = excluded.last_synced_at,
          convex_id = excluded.convex_id,
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
        chat.linkedType,
        chat.linkedPath,
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
        booleanInt(chat.dirty, true),
        chat.lastSyncedAt ?? null,
        chat.convexId ?? null,
        chat.updatedAt,
      );
  }

  private localKeyForEvent(event: ChatLifecycleEventRow): string | null {
    if (event.chatId) {
      return `chat:${event.harness}:${event.host}:${event.chatId}`;
    }
    if (event.launchId) return `launch:${event.launchId}`;
    return null;
  }

  private findLocalChatForEvent(event: ChatLifecycleEventRow): LocalChatRow | null {
    if (event.chatId) {
      const byChat = this.getLocalChat(
        `chat:${event.harness}:${event.host}:${event.chatId}`,
      );
      if (byChat) return byChat;
    }
    if (event.launchId) {
      const row = this.db
        .prepare("SELECT * FROM local_chats WHERE launch_id = ?")
        .get(event.launchId);
      if (row) return this.localChatFromRow(row);
    }
    const localKey = this.localKeyForEvent(event);
    return localKey ? this.getLocalChat(localKey) : null;
  }

  private reduceEventToLocalChat(
    event: ChatLifecycleEventRow,
    now: number,
  ): LocalChatInput | null {
    const localKey = this.localKeyForEvent(event);
    if (!localKey) return null;

    const existing = this.findLocalChatForEvent(event);
    const environment =
      optionalString(event.metadata.environment) ?? existing?.environment ?? null;
    const linkedType =
      event.metadata.linkedType === "task" ||
      event.metadata.linkedType === "note" ||
      event.metadata.linkedType === "automation"
        ? event.metadata.linkedType
        : existing?.linkedType ?? null;
    const linkedPath =
      optionalString(event.metadata.linkedPath) ?? existing?.linkedPath ?? null;
    const automationRunId =
      optionalString(event.metadata.automationRunId) ??
      optionalString(existing?.resumePayload.automationRunId);
    const title = normalizeChatTitle(
      optionalString(event.metadata.title) ?? existing?.title,
      event.harness,
    );
    const status = this.statusForEvent(event, existing?.status);
    const statusChanged = !existing || existing.status !== status;
    const endedAt =
      event.lifecycle === "session.ended"
        ? event.observedAt
        : existing?.endedAt ?? null;
    const pending = event.chatId ? false : existing?.pending ?? true;
    const chatId = event.chatId ?? existing?.chatId ?? null;

    return {
      localKey,
      projectId: event.projectId ?? existing?.projectId ?? null,
      launchId: event.launchId ?? existing?.launchId ?? null,
      harness: event.harness,
      chatId,
      pending,
      status,
      title,
      cwd: event.cwd || existing?.cwd || "",
      host: event.host || existing?.host || "",
      environment,
      linkedType,
      linkedPath,
      resumeKind: existing?.resumeKind ?? "open-chat-command",
      resumePayload: {
        ...(existing?.resumePayload ?? {}),
        launchId: event.launchId ?? existing?.launchId ?? null,
        chatId,
        cwd: event.cwd || existing?.cwd || "",
        linkedPath,
        automationRunId,
      },
      firstObservedAt: Math.min(existing?.firstObservedAt ?? event.observedAt, event.observedAt),
      lastEventAt: Math.max(existing?.lastEventAt ?? event.observedAt, event.observedAt),
      lastStatusAt: statusChanged
        ? event.observedAt
        : existing?.lastStatusAt ?? event.observedAt,
      endedAt,
      pinned: existing?.pinned ?? false,
      pinnedAt: existing?.pinnedAt ?? null,
      archivedAt: existing?.archivedAt ?? null,
      deletedAt: existing?.deletedAt ?? null,
      dirty: true,
      lastSyncedAt: existing?.lastSyncedAt ?? null,
      convexId: existing?.convexId ?? null,
      updatedAt: now,
    };
  }

  private statusForEvent(
    event: ChatLifecycleEventRow,
    fallback: ChatLifecycleStatus | undefined,
  ): ChatLifecycleStatus {
    if (event.status) return event.status;
    if (event.lifecycle === "session.ended") return "idle";
    if (event.lifecycle === "turn.needs_input") return "needs-input";
    if (event.lifecycle === "turn.completed") return "waiting";
    if (
      event.lifecycle === "chat.created" ||
      event.lifecycle === "chat.bound" ||
      event.lifecycle === "turn.started" ||
      event.lifecycle === "turn.resumed" ||
      event.lifecycle === "session.started"
    ) {
      return "working";
    }
    return fallback ?? "waiting";
  }

  private sameReducedChat(existing: LocalChatRow, next: LocalChatInput): boolean {
    return (
      existing.localKey === next.localKey &&
      existing.projectId === next.projectId &&
      existing.launchId === next.launchId &&
      existing.harness === next.harness &&
      existing.chatId === next.chatId &&
      existing.pending === next.pending &&
      existing.status === next.status &&
      existing.title === next.title &&
      existing.cwd === next.cwd &&
      existing.host === next.host &&
      existing.environment === next.environment &&
      existing.linkedType === next.linkedType &&
      existing.linkedPath === next.linkedPath &&
      existing.resumeKind === next.resumeKind &&
      JSON.stringify(existing.resumePayload) ===
        JSON.stringify(next.resumePayload ?? {}) &&
      existing.firstObservedAt === next.firstObservedAt &&
      existing.lastEventAt === next.lastEventAt &&
      existing.lastStatusAt === next.lastStatusAt &&
      existing.endedAt === next.endedAt &&
      existing.pinned === (next.pinned ?? false) &&
      existing.pinnedAt === (next.pinnedAt ?? null) &&
      existing.archivedAt === (next.archivedAt ?? null) &&
      existing.deletedAt === (next.deletedAt ?? null)
    );
  }

  private eventFromRow(row: unknown): ChatLifecycleEventRow {
    const value = row as Record<string, unknown>;
    return {
      seq: numberFromSqlite(value.seq),
      eventId: String(value.event_id),
      schemaVersion: numberFromSqlite(value.schema_version) as 1,
      source: String(value.source) as ChatLifecycleSource,
      producer: String(value.producer) as ChatLifecycleProducer,
      harness: String(value.harness) as ChatLifecycleHarness,
      providerEvent: String(value.provider_event),
      lifecycle: String(value.lifecycle) as ChatLifecycleKind,
      status: value.status === null ? null : (String(value.status) as ChatLifecycleStatus),
      projectId: value.project_id === null ? null : String(value.project_id),
      projectLocalPath:
        value.project_local_path === null ? null : String(value.project_local_path),
      chatId: value.chat_id === null ? null : String(value.chat_id),
      launchId: value.launch_id === null ? null : String(value.launch_id),
      turnId: value.turn_id === null ? null : String(value.turn_id),
      cwd: String(value.cwd),
      host: String(value.host),
      observedAt: numberFromSqlite(value.observed_at),
      rawPayloadHash:
        value.raw_payload_hash === null ? null : String(value.raw_payload_hash),
      rawPayloadRef:
        value.raw_payload_ref === null ? null : String(value.raw_payload_ref),
      metadata: jsonObject(String(value.metadata_json)),
      reducedAt:
        value.reduced_at === null ? null : numberFromSqlite(value.reduced_at),
    };
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
      linkedType:
        value.linked_type === null
          ? null
          : (String(value.linked_type) as "task" | "note" | "automation"),
      linkedPath: value.linked_path === null ? null : String(value.linked_path),
      resumeKind: String(value.resume_kind) as "open-chat-command" | "external",
      resumePayload: jsonObject(String(value.resume_payload_json)),
      firstObservedAt: numberFromSqlite(value.first_observed_at),
      lastEventAt: numberFromSqlite(value.last_event_at),
      lastStatusAt: numberFromSqlite(value.last_status_at),
      endedAt: value.ended_at === null ? null : numberFromSqlite(value.ended_at),
      pinned: bool(value.pinned),
      pinnedAt: value.pinned_at === null ? null : numberFromSqlite(value.pinned_at),
      archivedAt:
        value.archived_at === null ? null : numberFromSqlite(value.archived_at),
      deletedAt:
        value.deleted_at === null ? null : numberFromSqlite(value.deleted_at),
      dirty: bool(value.dirty),
      lastSyncedAt:
        value.last_synced_at === null
          ? null
          : numberFromSqlite(value.last_synced_at),
      convexId: value.convex_id === null ? null : String(value.convex_id),
      updatedAt: numberFromSqlite(value.updated_at),
    };
  }
}

export function openChatLifecycleStore(
  options: ChatLifecycleStoreOptions = {},
): ChatLifecycleStore {
  return new ChatLifecycleStore(options);
}
