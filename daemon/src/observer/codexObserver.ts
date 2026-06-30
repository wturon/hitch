import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ObservedActivity } from "./types.js";

// CODEX_HOME relocates the whole ~/.codex tree; CODEX_SQLITE_HOME relocates just
// the durable SQLite state. Honor both before observing, per the doc's escape
// hatches.
export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function codexSqlitePath(): string {
  const base = process.env.CODEX_SQLITE_HOME?.trim() || codexHome();
  return join(base, "state_5.sqlite");
}

export interface CodexThread {
  id: string;
  rolloutPath: string;
  cwd: string;
  archived: boolean;
  updatedAtMs: number;
  title: string | null;
  source: string | null;
}

// Read the durable thread catalog — the Codex "index" (existence + identity +
// pointer to the rollout log). Newest-activity first, bounded so an enormous
// history doesn't turn into thousands of observed rows. Opened read-only so we
// never create or migrate Codex's own database.
export function readCodexThreads(limit = 200): CodexThread[] {
  const path = codexSqlitePath();
  if (!existsSync(path)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT id, rollout_path, cwd, archived, title, source,
                COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms
         FROM threads
         ORDER BY updated_ms DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      rolloutPath: String(row.rollout_path),
      cwd: typeof row.cwd === "string" ? row.cwd : "",
      archived: Number(row.archived) === 1,
      updatedAtMs: Number(row.updated_ms) || 0,
      title:
        typeof row.title === "string" && row.title.trim() ? row.title : null,
      source: typeof row.source === "string" ? row.source : null,
    }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

// Activity from the latest rollout-turn suffix, per the doc's rules. We scan the
// tail backward and stop at the first decisive marker: a closed turn
// (`task_complete` / `turn_aborted`) is idle; an open turn (started, an
// assistant/reasoning message, an open or just-returned tool call) is working.
// `token_count` is ambiguous and skipped. `unknown` when the tail carries no
// recognizable turn marker.
const WORKING_EVENT_MSG = new Set([
  "task_started",
  "user_message",
  "agent_message",
]);
const WORKING_RESPONSE_ITEM = new Set([
  "message",
  "reasoning",
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "function_call_output",
  "custom_tool_call_output",
  "mcp_tool_call_end",
  "patch_apply_end",
]);

export function deriveCodexRolloutActivity(lines: string[]): {
  activity: ObservedActivity;
  marker: string | null;
} {
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(lines[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = obj.type;
    const payload = obj.payload as { type?: unknown } | undefined;
    const pt = typeof payload?.type === "string" ? payload.type : null;
    if (!pt) continue;

    if (type === "event_msg") {
      if (pt === "task_complete") return { activity: "idle", marker: pt };
      if (WORKING_EVENT_MSG.has(pt)) return { activity: "working", marker: pt };
      // token_count and others: ambiguous, keep scanning.
    } else if (type === "response_item") {
      if (pt === "turn_aborted") return { activity: "idle", marker: pt };
      if (WORKING_RESPONSE_ITEM.has(pt)) {
        return { activity: "working", marker: pt };
      }
    }
  }
  return { activity: "unknown", marker: null };
}
