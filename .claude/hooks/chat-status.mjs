#!/usr/bin/env node
// Claude Code lifecycle hook: stamp a task's live chat status into its
// frontmatter so the Hitch board can show a "working / ready / needs input"
// indicator on the card. Wired up in ../settings.json for the events below.
//
// The board already renders cards from `.hitch/tasks/<slug>/task.md` (daemon
// syncs the file -> Convex -> web), so writing `chat-status` into that file is
// all it takes to light up the card — no new transport. This is the automated
// version of "just put the status in the file": the agent self-links its
// session id once (chat-id), and from then on these hooks keep chat-status
// current without the agent having to remember.
//
// Mechanism note: this is the same lifecycle Claude Code uses for the terminal
// "ding + blue dot" — UserPromptSubmit = turn started, Stop = finished/your turn.
//
// Contract: hooks must never break the session. We read the event payload from
// stdin, do a best-effort frontmatter edit, and always exit 0.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// hook_event_name -> the status we stamp. null means "clear the key".
const STATUS_FOR_EVENT = {
  UserPromptSubmit: "working",
  Stop: "waiting",
  SessionEnd: null,
};

const TERMINAL_TASK_STATUSES = new Set(["archived", "done"]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Minimal scalar frontmatter reader, matching web/lib/frontmatter.ts.
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

// Set or (with undefined) remove one scalar key, preserving body + other keys.
// Mirrors setFrontmatterKeys in web/lib/frontmatter.ts.
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

function taskStatus(fm) {
  return (fm.status ?? "").trim().toLowerCase().replace(/\s+/g, "-");
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || "{}");
  } catch {
    return; // malformed input — nothing to do
  }

  const event = payload.hook_event_name;
  if (!(event in STATUS_FOR_EVENT)) return;
  const status = STATUS_FOR_EVENT[event];

  const sessionId = payload.session_id;
  if (!sessionId) return;

  // The agent's task lives under <cwd>/.hitch/tasks/<slug>/task.md. cwd is on
  // the payload; fall back to the project dir / process cwd if it's missing.
  const root =
    payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
    if (!fm || fm["chat-id"] !== sessionId) continue;

    // Found the task driven by this session. Once the task is complete or
    // archived, a finished turn should clear any stale live indicator.
    const nextStatus =
      status === "waiting" && TERMINAL_TASK_STATUSES.has(taskStatus(fm))
        ? undefined
        : status;

    // Skip the write if nothing changes — avoids needless file churn (and a
    // re-render) every turn.
    const current = (fm["chat-status"] ?? "").trim() || null;
    if (current === (nextStatus ?? null)) return;

    try {
      writeFileSync(file, setKey(content, "chat-status", nextStatus));
    } catch {
      // best-effort; never fail the hook
    }
    return; // chat-id is unique per task
  }
}

try {
  main();
} catch {
  // Never let a hook error interrupt the session.
}
