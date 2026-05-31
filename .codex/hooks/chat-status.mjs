#!/usr/bin/env node
// Codex lifecycle hook: stamp a task's live chat status into frontmatter so the
// Hitch board can show whether the linked Codex chat is actively working.
//
// Contract: hooks must never break the session. We read the event payload from
// stdin, do a best-effort frontmatter edit, and always exit 0.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATUS_FOR_EVENT = {
  UserPromptSubmit: "working",
  userPromptSubmit: "working",
  Stop: "waiting",
  stop: "waiting",
};

const TERMINAL_TASK_STATUSES = new Set(["archived", "done"]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    fm[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return fm;
}

function setKey(content, key, value) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const match = content.match(FRONTMATTER_RE);
  let lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? match[2] : content;
  lines = lines.filter((line) => {
    const idx = line.indexOf(":");
    return idx === -1 || line.slice(0, idx).trim() !== key;
  });
  if (value != null && value !== "") lines.push(`${key}: ${value}`);
  return `---${eol}${lines.join(eol)}${eol}---${eol}${body}`;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function candidateChatIds(payload) {
  const candidates = [
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
    payload.thread?.id,
    process.env.CODEX_THREAD_ID,
  ]
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  let transcriptPath = "";
  if (typeof payload.transcript_path === "string") {
    transcriptPath = payload.transcript_path;
  } else if (typeof payload.transcriptPath === "string") {
    transcriptPath = payload.transcriptPath;
  }
  const transcriptId = transcriptPath.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (transcriptId) candidates.push(transcriptId[0]);

  return new Set(candidates);
}

function taskStatus(fm) {
  return (fm.status ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  const event = payload.hook_event_name || payload.hookEventName;
  if (!(event in STATUS_FOR_EVENT)) return;
  const status = STATUS_FOR_EVENT[event];

  const chatIds = candidateChatIds(payload);
  if (chatIds.size === 0) return;

  const root =
    payload.cwd ||
    process.env.CODEX_PROJECT_DIR ||
    process.env.PWD ||
    process.cwd();
  const tasksDir = join(root, ".hitch", "tasks");
  if (!existsSync(tasksDir)) return;

  let slugs;
  try {
    slugs = readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of slugs) {
    if (!entry.isDirectory()) continue;
    const file = join(tasksDir, entry.name, "task.md");
    if (!existsSync(file)) continue;

    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const fm = parseFrontmatter(content);
    if (!fm || !chatIds.has(fm["chat-id"])) continue;

    const nextStatus =
      status === "waiting" && TERMINAL_TASK_STATUSES.has(taskStatus(fm))
        ? undefined
        : status;
    const current = (fm["chat-status"] ?? "").trim() || null;
    if (current === (nextStatus ?? null)) return;

    try {
      writeFileSync(file, setKey(content, "chat-status", nextStatus));
    } catch {
      // Best effort; never fail the hook.
    }
    return;
  }
}

try {
  main();
} catch {
  // Never let a hook error interrupt the session.
}
