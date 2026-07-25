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
//   codex  — there is no id to pin. The record is stamped with the cmux
//            surface id BEFORE the command runs, and the hook's
//            `CMUX_SURFACE_ID` joins on it when Codex reports its thread.
//            Surface ids are unique per pane, so the join is deterministic:
//            more than one candidate is NEVER guessed at.
//
// This file used to be split in two — `daemon/src/codexCmuxLaunchClaims.ts`
// (the writer) and ~90 lines inlined in the hook template in
// `desktop/src/main/main.ts` (the matcher). The hook now records only the
// surface id it was launched under; the match happens here, in one process,
// which also removes the two-writer race on the file.
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
  /** cmux pane id — the codex join key, stamped before the command runs. */
  surfaceId?: string;
  /** The harness's own session/thread id, once known. */
  sessionId?: string;
  /** When a surface claim was consumed. A claimed record is never re-matched. */
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

  /** Stamp the cmux surface onto a launch. No-op when the launch is unknown. */
  stampSurface(launchId: string, surfaceId: string, now = Date.now()): void {
    const records = this.list(now);
    const index = records.findIndex((r) => r.launchId === launchId);
    if (index < 0) return;
    records[index] = { ...records[index], surfaceId };
    this.write(records);
  }

  /**
   * The deterministic surface-id join, moved verbatim out of the hook template.
   *
   * A candidate must be fresh, unclaimed, a cmux launch, and carry exactly the
   * surface id the hook fired under (case-insensitively). If the number of
   * candidates is anything other than ONE we return null and never guess —
   * each launch owns a distinct pane, so concurrent launches resolve
   * independently and two identical-prompt launches can no longer collide.
   */
  claimBySurface(surfaceId: string, sessionId: string, now = Date.now()): LaunchRecord | null {
    if (!surfaceId || !sessionId) return null;
    const wanted = surfaceId.toLowerCase();
    const all = this.readAll();
    const records = all.filter((r) => now - r.createdAt <= LAUNCH_TTL_MS);
    const matches = records.filter(
      (r) =>
        r.claimedAt === undefined &&
        r.environment === "cmux" &&
        typeof r.surfaceId === "string" &&
        r.surfaceId.toLowerCase() === wanted,
    );
    if (matches.length !== 1) {
      // Persist the pruning if we dropped any, and ONLY then — this runs on
      // every codex hook event on the machine, including ones for chats we
      // never launched, and it must not write a file per turn.
      if (records.length !== all.length) this.write(records);
      return null;
    }
    const claimed: LaunchRecord = { ...matches[0], claimedAt: now, sessionId };
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

// ─── launcher-facing helpers ────────────────────────────────────────────────
// `daemon/src/launchers/cmuxCodex.ts` has no injected state, so it reaches the
// store through these two. Same contract the old
// record/updateCodexCmuxLaunchClaim pair had.

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

export function stampCmuxSurface(input: {
  launchId?: string;
  surfaceId?: string | null;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!input.launchId || !input.surfaceId) return;
  new LaunchStore({ env: input.env }).stampSurface(input.launchId, input.surfaceId);
}
