// The attachment layer's durable half — launch records.
//
// docs/chat-tracking-redesign.md §4: observation is environment-blind, and
// everything about "which chat did Hitch start, and how do we get back to it"
// lives HERE, next to the launchers. Nothing in `daemon/src/observer/` may
// import this file (the boundary is enforced by
// `npm -w @hitch/daemon run smoke:observer-boundary`).
//
// One record per launch, keyed by the launchId the reconciler mints:
//
//   claude — the session id is known before the process starts
//            (`claude --session-id`), so the record carries it from the start
//            and the chat is pre-registered as `pending` in the snapshot.
//   codex  — there is no id to pin (`--session-id` does not exist on the Codex
//            CLI). The launchId itself is exported as HITCH_LAUNCH_ID on the
//            Codex command; Codex hands its environment to every hook process,
//            so the hook reports OUR nonce next to Codex's own session id and
//            the join is a direct lookup by primary key.
//
// The codex join used to key on the cmux SURFACE id, stamped here before launch.
// That was deterministic but environment-bound — it could only ever attach chats
// running inside cmux, and it put a terminal's pane model in the identity path.
// The nonce is ours and travels with our own process, so the same join works in
// cmux, an editor, a bare shell, or whatever we support next.
//
// This file used to be split in two — `daemon/src/codexCmuxLaunchClaims.ts`
// (the writer) and ~90 lines inlined in the hook template in
// `desktop/src/main/main.ts` (the matcher). The match happens here, in one
// process, which also removes the two-writer race on the file.
//
// Durable on purpose: a daemon restart between "we launched it" and "it bound"
// must not lose the assignment→chat link, and must not re-spawn.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { appSupportDirFromEnv } from "../v2/config.js";

/** A launch older than this is abandoned: it never bound, and never will. */
export const LAUNCH_TTL_MS = 10 * 60 * 1000;

export type LaunchHarness = "claude" | "codex";

export interface LaunchRecord {
  launchId: string;
  environment: "cmux";
  createdAt: number;
  harness?: LaunchHarness;
  /** The assignment this launch serves. Null for a launch nothing delegated. */
  assignmentId?: string | null;
  projectId?: string | null;
  title?: string | null;
  cwd?: string | null;
  /** The harness's own session/thread id, once known. */
  sessionId?: string;
  /** When the codex nonce claim was consumed. A claimed record is never re-matched. */
  claimedAt?: number;
  /** When the assignment was linked to its server chat row. */
  linkedAt?: number;
}

function isLaunchRecord(value: unknown): value is LaunchRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.launchId === "string" &&
    record.environment === "cmux" &&
    typeof record.createdAt === "number"
  );
}

export class LaunchStore {
  readonly path: string;

  constructor(options: { path?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.path =
      options.path ?? join(appSupportDirFromEnv(options.env ?? process.env), "launches.json");
  }

  /** Every non-expired record. Unreadable/garbage file → no records, never a throw. */
  list(now = Date.now()): LaunchRecord[] {
    return this.readAll().filter((r) => now - r.createdAt <= LAUNCH_TTL_MS);
  }

  private readAll(): LaunchRecord[] {
    if (!existsSync(this.path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isLaunchRecord);
  }

  /**
   * Create or merge a record. Merging matters: the reconciler records the
   * attachment (assignment, project, cwd) and the launcher then records the
   * same launch as a cmux launch — neither may clobber the other.
   */
  record(input: Partial<LaunchRecord> & { launchId: string }, now = Date.now()): void {
    const records = this.list(now);
    const index = records.findIndex((r) => r.launchId === input.launchId);
    if (index < 0) {
      records.push({ environment: "cmux", createdAt: now, ...input });
    } else {
      records[index] = { ...records[index], ...input };
    }
    this.write(records);
  }

  /**
   * The codex join: bind a launch to the session id the hook reported under our
   * own nonce. A lookup by primary key, not a search — the nonce came back from
   * the process we set it on, so there is nothing to disambiguate and nothing to
   * guess. An unknown or expired nonce claims nothing.
   *
   * Idempotent by design. The nonce rides on EVERY codex hook event, so the
   * second and later events for a chat re-present a launch already claimed;
   * those return the record unchanged rather than rewriting the file per turn.
   */
  claimByLaunchId(launchId: string, sessionId: string, now = Date.now()): LaunchRecord | null {
    if (!launchId || !sessionId) return null;
    const all = this.readAll();
    const records = all.filter((r) => now - r.createdAt <= LAUNCH_TTL_MS);
    const match = records.find((r) => r.launchId === launchId);
    if (!match || (match.sessionId !== undefined && match.sessionId !== sessionId)) {
      // Persist the pruning if we dropped any, and ONLY then — this runs on
      // every codex hook event on the machine, including ones for chats we
      // never launched, and it must not write a file per turn.
      if (records.length !== all.length) this.write(records);
      return null;
    }
    if (match.claimedAt !== undefined) return match;
    const claimed: LaunchRecord = { ...match, claimedAt: now, sessionId };
    this.write(records.map((r) => (r.launchId === claimed.launchId ? claimed : r)));
    return claimed;
  }

  /** The record bound to a session id, if we launched it. */
  forSession(sessionId: string, now = Date.now()): LaunchRecord | null {
    if (!sessionId) return null;
    return this.list(now).find((r) => r.sessionId === sessionId) ?? null;
  }

  /** Bind a session id known up front (claude) or resolved late (codex). */
  bindSession(launchId: string, sessionId: string, now = Date.now()): void {
    this.record({ launchId, sessionId }, now);
  }

  markLinked(launchId: string, now = Date.now()): void {
    this.record({ launchId, linkedAt: now }, now);
  }

  drop(launchId: string, now = Date.now()): void {
    this.write(this.list(now).filter((r) => r.launchId !== launchId));
  }

  dropForAssignment(assignmentId: string, now = Date.now()): void {
    this.write(this.list(now).filter((r) => r.assignmentId !== assignmentId));
  }

  /**
   * Drop everything past the TTL and report what was dropped, so the caller can
   * settle the assignments those launches never bound to.
   */
  pruneExpired(now = Date.now()): LaunchRecord[] {
    const all = this.readAll();
    const fresh = all.filter((r) => now - r.createdAt <= LAUNCH_TTL_MS);
    if (fresh.length !== all.length) this.write(fresh);
    return all.filter((r) => now - r.createdAt > LAUNCH_TTL_MS);
  }

  private write(records: LaunchRecord[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      renameSync(tmp, this.path);
    } catch {
      // Best-effort: losing a record costs a link, never the harness.
    }
  }
}

// ─── launcher-facing helper ─────────────────────────────────────────────────
// `daemon/src/launchers/cmuxCodex.ts` has no injected state, so it reaches the
// store through this. `stampCmuxSurface` used to live beside it and is gone with
// the surface-id join — the launcher now carries the nonce on the command
// itself, so there is nothing to write back out of band.

export function recordCmuxLaunch(input: {
  launchId?: string;
  harness?: LaunchHarness;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!input.launchId) return;
  new LaunchStore({ env: input.env }).record({
    launchId: input.launchId,
    ...(input.harness ? { harness: input.harness } : {}),
  });
}

