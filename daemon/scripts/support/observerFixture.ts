// A fake machine for the chat-observer smokes.
//
// Builds a throwaway CLAUDE_CONFIG_DIR / CODEX_HOME / HITCH_APP_SUPPORT_DIR and
// points the process env at them, so the observer sees a world we control:
//   - a LIVE Claude session (a real child process whose argv names the session
//     id, plus the pidfile Claude itself would write)
//   - a DORMANT Claude transcript (no process, mtime inside the window)
//   - a Codex thread in Codex's own state_5.sqlite catalog
//
// Everything here is fabricated on disk exactly the way the real harnesses do
// it — the point of the exercise is that the daemon keeps NO state of its own,
// so the machine has to be the only input.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface FakeMachine {
  root: string;
  appSupportDir: string;
  claudeHome: string;
  codexHome: string;
  projectDir: string;
  liveSessionId: string;
  dormantSessionId: string;
  codexThreadId: string;
  /** Remove the live session's pidfile, simulating a clean exit. */
  killLiveSession: () => void;
  /**
   * Rewrite the live session's self-reported `status`. Pass null to simulate a
   * vscode session, which reports nothing — the one case where the observer
   * falls back to reading the transcript tail (and so keeps a cursor).
   */
  setLiveStatus: (status: string | null) => void;
  /** Archive the Codex thread out of the catalog, so it vanishes entirely. */
  removeCodexThread: () => void;
  cleanup: () => void;
}

function touchTranscript(path: string, cwd: string, closed: boolean): void {
  const lines = [
    JSON.stringify({ type: "user", cwd, message: { role: "user", content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      cwd,
      message: { role: "assistant", stop_reason: closed ? "end_turn" : null },
    }),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

export function createFakeMachine(): FakeMachine {
  const root = mkdtempSync(join(tmpdir(), "hitch-observer-"));
  const appSupportDir = join(root, "app-support");
  const claudeHome = join(root, "dot-claude");
  const codexHome = join(root, "dot-codex");
  const projectDir = join(root, "repo");
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  mkdirSync(join(claudeHome, "projects", "-repo"), { recursive: true });
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(appSupportDir, { recursive: true });

  process.env.HITCH_APP_SUPPORT_DIR = appSupportDir;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_SQLITE_HOME;

  const liveSessionId = randomUUID();
  const dormantSessionId = randomUUID();
  const codexThreadId = randomUUID();

  // A real live process whose command line names the session id — that is what
  // `pidOwnsSession` reads to prove the pid wasn't recycled. The id goes in the
  // SCRIPT PATH because a shell `exec`s away anything we put in its argv.
  const stubPath = join(root, `claude-${liveSessionId}.mjs`);
  writeFileSync(stubPath, "setTimeout(() => {}, 120_000);\n", "utf8");
  const child: ChildProcess = spawn(process.execPath, [stubPath], {
    stdio: "ignore",
    detached: false,
  });

  const pidfilePath = join(claudeHome, "sessions", `${child.pid}.json`);
  const writePidfile = (status: string | null) =>
    writeFileSync(
      pidfilePath,
      JSON.stringify({
        pid: child.pid,
        sessionId: liveSessionId,
        cwd: projectDir,
        startedAt: Date.now(),
        procStart: new Date().toISOString(),
        version: "2.1.200",
        kind: "cli",
        entrypoint: status === null ? "claude-vscode" : "cli",
        name: "Live smoke chat",
        status,
        updatedAt: Date.now(),
        statusUpdatedAt: Date.now(),
      }),
      "utf8",
    );
  writePidfile("busy");

  touchTranscript(join(claudeHome, "projects", "-repo", `${liveSessionId}.jsonl`), projectDir, false);
  touchTranscript(
    join(claudeHome, "projects", "-repo", `${dormantSessionId}.jsonl`),
    projectDir,
    true,
  );

  // Codex's own thread catalog. Built with the same columns the real
  // state_5.sqlite has, so `readCodexThreads` reads it unchanged.
  const codexDb = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  codexDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      source TEXT,
      updated_at INTEGER,
      updated_at_ms INTEGER,
      recency_at_ms INTEGER
    );
  `);
  const rolloutPath = join(codexHome, "sessions", `rollout-${codexThreadId}.jsonl`);
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })}\n`,
    "utf8",
  );
  codexDb
    .prepare(
      `INSERT INTO threads (id, rollout_path, cwd, archived, title, source, updated_at, updated_at_ms, recency_at_ms)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    )
    .run(
      codexThreadId,
      rolloutPath,
      projectDir,
      "Codex smoke thread",
      "cli",
      Math.round(Date.now() / 1000),
      // Older than CODEX_RUNNING_FRESH_MS so it reads as dormant without a
      // `codex resume` process to prove otherwise.
      Date.now() - 5 * 60_000,
      Date.now() - 5 * 60_000,
    );
  codexDb.close();

  return {
    root,
    appSupportDir,
    claudeHome,
    codexHome,
    projectDir,
    liveSessionId,
    dormantSessionId,
    codexThreadId,
    killLiveSession: () => {
      rmSync(pidfilePath, { force: true });
      child.kill("SIGKILL");
    },
    setLiveStatus: writePidfile,
    removeCodexThread: () => {
      const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
      db.prepare("DELETE FROM threads WHERE id = ?").run(codexThreadId);
      db.close();
    },
    cleanup: () => {
      child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Write one event into the spool the way the installed hook does: a JSON file
// named <epochMs>-<hex>.json, renamed into place.
export function spoolHookEvent(
  eventsDir: string,
  event: Record<string, unknown>,
): void {
  mkdirSync(eventsDir, { recursive: true });
  const name = `${String(event.observedAt ?? Date.now())}-${Math.random().toString(16).slice(2, 8)}`;
  writeFileSync(join(eventsDir, `${name}.json`), `${JSON.stringify(event)}\n`, "utf8");
}

export function hookEvent(
  harness: "claude-code" | "codex",
  chatId: string,
  lifecycle: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    source: "hook",
    producer: harness === "codex" ? "codex-hook" : "claude-code-hook",
    harness,
    providerEvent: lifecycle === "turn.needs_input" ? "Notification" : "Stop",
    lifecycle,
    status: null,
    projectId: null,
    projectLocalPath: null,
    chatId,
    launchId: null,
    turnId: null,
    cwd: "/tmp",
    host: "smoke-host",
    observedAt: Date.now(),
    rawPayloadHash: null,
    rawPayloadRef: null,
    metadata: {},
    ...overrides,
  };
}
