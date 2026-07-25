// The snapshot sink: PUT /daemon/machines/:id/chat-snapshot.
//
// docs/chat-tracking-redesign.md §7. This replaces the old per-row POST/PATCH
// relay (`chatSync.ts`) entirely. What that bought us by deleting it:
//
//   - no dirty cursor to drift out of sync with reality
//   - no `isRepresentable` / permanent-skip bookkeeping (a 400 can't storm when
//     there's one request carrying everything)
//   - no local↔server id map — the server keys on (machine, harness, session)
//   - no heal logic anywhere: a chat missing from the body is no longer live
//
// The daemon REPORTS; the server decides. Nothing here maps a status.

import type { ChatSnapshot } from "../observer/types.js";
import type { HitchClient } from "./serverClient.js";

export interface ChatSnapshotSinkLogger {
  info: (message: string) => void;
  error?: (message: string) => void;
}

export interface ChatSnapshotSinkOptions {
  client: HitchClient;
  machineId: string;
  logger: ChatSnapshotSinkLogger;
  now?: () => number;
  /** Re-send an unchanged snapshot at least this often, to keep last_observed_at honest. */
  refreshMs?: number;
}

export interface ChatSnapshotSinkResult {
  sent: boolean;
  skipped: boolean;
  ok: boolean;
  status?: number;
}

const DEFAULT_REFRESH_MS = 60_000;

// Everything in a snapshot except the wall clock. Two ticks that describe the
// same world produce the same string, which is what "skip when unchanged" means.
function fingerprint(snapshot: ChatSnapshot): string {
  return JSON.stringify({
    window: { since: snapshot.window.since, truncated: snapshot.window.truncated },
    chats: snapshot.chats.map((c) => ({
      h: c.harness,
      s: c.sessionId,
      e: c.existence,
      a: c.activity,
      b: c.block ?? null,
      p: c.process?.pid ?? null,
      c: c.cwd,
      t: c.title ?? null,
      j: c.projectId,
      // `source`/`evidence` move constantly (mtime ages tick every second) and
      // are debug context, not state — excluded on purpose so a quiet machine
      // is genuinely quiet on the wire.
    })),
  });
}

export class ChatSnapshotSink {
  private readonly client: HitchClient;
  private readonly machineId: string;
  private readonly logger: ChatSnapshotSinkLogger;
  private readonly now: () => number;
  private readonly refreshMs: number;

  private lastFingerprint: string | null = null;
  private lastSentAt = 0;

  constructor(options: ChatSnapshotSinkOptions) {
    this.client = options.client;
    this.machineId = options.machineId;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  }

  async put(snapshot: ChatSnapshot): Promise<ChatSnapshotSinkResult> {
    const print = fingerprint(snapshot);
    const stale = this.now() - this.lastSentAt >= this.refreshMs;
    if (snapshot.events.length === 0 && print === this.lastFingerprint && !stale) {
      return { sent: false, skipped: true, ok: true };
    }

    try {
      const res = await this.client.daemon.machines[":id"]["chat-snapshot"].$put({
        param: { id: this.machineId },
        json: snapshot,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.logger.error?.(
          `[hitch] chat snapshot rejected (${res.status}${detail ? `: ${detail}` : ""})`,
        );
        // Do NOT record the fingerprint: a rejected snapshot must be retried,
        // and the next tick is the retry.
        return { sent: true, skipped: false, ok: false, status: res.status };
      }
      const body = (await res.json()) as {
        upserted?: number;
        dead?: number;
        events?: number;
        eventsDropped?: number;
      };
      this.lastFingerprint = print;
      this.lastSentAt = this.now();
      if ((body.dead ?? 0) > 0 || (body.eventsDropped ?? 0) > 0) {
        this.logger.info(
          `[hitch] chat snapshot: ${body.upserted ?? 0} observed, ${body.dead ?? 0} dead, ` +
            `${body.events ?? 0} events (${body.eventsDropped ?? 0} dropped)`,
        );
      }
      return { sent: true, skipped: false, ok: true, status: res.status };
    } catch (error) {
      this.logger.error?.(`[hitch] chat snapshot error: ${String(error)}`);
      return { sent: true, skipped: false, ok: false };
    }
  }
}
