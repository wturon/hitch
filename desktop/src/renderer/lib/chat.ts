// A task can reference the coding-agent chat that's driving it, so the board can
// jump back to that conversation. The reference rides the task's frontmatter as
// flat `chat-*` keys (the reader in ./frontmatter is scalar-only), e.g.
//
//   chat-harness: claude-code
//   chat-id: 9f8e7d6c-1234-...
//   chat-cwd: /Users/will/code/hitch
//
// MVP scope is single-machine: the launch action assumes the board is open on
// the same Mac that owns the session. See README / the daemon command-bus idea
// for cross-machine routing later.

import type { Frontmatter } from "./frontmatter";
import { setFrontmatterKeys } from "./frontmatter";

export type Harness = "claude-code" | "codex";

export interface ChatRef {
  harness: Harness;
  id: string;
  cwd?: string; // claude-code only: where to resume the session
}

export const HARNESSES: Harness[] = ["claude-code", "codex"];

export function harnessLabel(harness: Harness): string {
  return harness === "codex" ? "Codex" : "Claude Code";
}

// Where a harness runs and is presented to the user. Today there is one
// environment per harness (the daemon derives it from the harness), but the
// settings UI models this axis explicitly so future environments (e.g. the VS Code
// extension) slot in without reshaping the mental model. Keep in sync with the
// daemon's launcher registry.
export type Environment = "cmux" | "codex-app" | "vscode" | "cursor";

export interface EnvironmentOption {
  id: Environment;
  label: string;
}

export const ENVIRONMENTS_BY_HARNESS: Record<Harness, EnvironmentOption[]> = {
  "claude-code": [
    { id: "cmux", label: "cmux (TUI)" },
    { id: "vscode", label: "VS Code extension" },
    { id: "cursor", label: "Cursor extension" },
  ],
  codex: [
    { id: "codex-app", label: "Codex app" },
    { id: "vscode", label: "VS Code extension" },
    { id: "cursor", label: "Cursor extension" },
  ],
};

export function defaultEnvironment(harness: Harness): Environment {
  return harness === "codex" ? "codex-app" : "cmux";
}

export function environmentLabel(env: Environment): string {
  switch (env) {
    case "codex-app":
      return "Codex app";
    case "vscode":
      return "VS Code extension";
    case "cursor":
      return "Cursor extension";
    default:
      return "cmux (TUI)";
  }
}

export function isEnvironment(value: string): value is Environment {
  return (
    value === "cmux" ||
    value === "codex-app" ||
    value === "vscode" ||
    value === "cursor"
  );
}

// Live runtime state of the chat driving a task, written into frontmatter as
// `chat-status` by the harness's lifecycle hooks (see .claude/hooks/chat-status.mjs):
//   working — mid-turn, actively processing (no human action needed)
//   waiting — finished a turn, your turn to act
// Absent means we have no live signal (chat closed, never linked, or pre-hooks).
export type ChatStatus = "working" | "waiting";

const CHAT_STATUSES = new Set<string>(["working", "waiting"]);

const CHAT_STATUS_ALIASES: Record<string, ChatStatus> = {
  active: "working",
  busy: "working",
  running: "working",
  ready: "waiting",
  idle: "waiting",
  "needs-input": "waiting",
  needs_input: "waiting",
};

function normalizeStatusValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

export function normalizeChatStatus(value: string): ChatStatus | null {
  const normalized = normalizeStatusValue(value);
  if (CHAT_STATUSES.has(normalized)) return normalized as ChatStatus;
  return CHAT_STATUS_ALIASES[normalized] ?? null;
}

export function parseChatStatus(fm: Frontmatter): ChatStatus | null {
  return normalizeChatStatus(fm["chat-status"] ?? "");
}

// Codex threads launched by Hitch's daemon briefly exist only inside the
// daemon-managed app-server. During that handoff window, opening the normal
// `codex://threads/<id>` deep link can strand the user on a loading screen.
export type ChatOpenState = "pending";

export function parseChatOpenState(fm: Frontmatter): ChatOpenState | null {
  return normalizeStatusValue(fm["chat-open-state"] ?? "") === "pending"
    ? "pending"
    : null;
}

// The three states the delegation UI distinguishes: the agent is mid-turn
// ("working"), it has a live signal but isn't mid-turn ("not-working"), or we
// have no live signal at all ("none" — closed, never linked, or a harness like
// Codex with no status hooks). "waiting" collapses into "not-working".
export type ChatActivity = "working" | "not-working" | "none";

export function chatActivity(status: ChatStatus | null): ChatActivity {
  if (status === "working") return "working";
  return status ? "not-working" : "none";
}

function isHarness(value: string): value is Harness {
  return (HARNESSES as string[]).includes(value);
}

// Read a chat reference from parsed frontmatter. Returns null unless both a
// known harness and a non-empty id are present, so callers can treat null as
// "no usable link yet".
export function parseChatRef(fm: Frontmatter): ChatRef | null {
  const harness = (fm["chat-harness"] ?? "").trim();
  const id = (fm["chat-id"] ?? "").trim();
  const cwd = (fm["chat-cwd"] ?? "").trim();
  if (!isHarness(harness) || !id) return null;
  return cwd ? { harness, id, cwd } : { harness, id };
}

// Raw, possibly-incomplete field values backing the link editor. Unlike
// ChatRef these can be half-filled while the user is still typing.
export interface ChatFields {
  harness: string;
  id: string;
  cwd: string;
}

export function readChatFields(fm: Frontmatter): ChatFields {
  return {
    harness: (fm["chat-harness"] ?? "").trim(),
    id: (fm["chat-id"] ?? "").trim(),
    cwd: (fm["chat-cwd"] ?? "").trim(),
  };
}

// Write the editor's fields back into raw file content, preserving the body and
// every other frontmatter key. Empty values are removed; cwd only applies to
// Claude Code.
export function writeChatFields(content: string, fields: ChatFields): string {
  return setFrontmatterKeys(content, {
    "chat-harness": fields.harness || undefined,
    "chat-id": fields.id || undefined,
    "chat-cwd":
      fields.harness === "claude-code" ? fields.cwd || undefined : undefined,
  });
}

export function clearChatFields(content: string): string {
  return setFrontmatterKeys(content, {
    "chat-harness": undefined,
    "chat-id": undefined,
    "chat-cwd": undefined,
    "chat-status": undefined,
    "chat-open-state": undefined,
  });
}

// The seed prompt for a brand-new coding-agent session launched from a task.
// Both harnesses are linked by the daemon before the first model turn starts, so
// the agent can focus on the task instead of introspecting its own session id.
export function defaultStartPrompt(
  task: { title: string; path: string },
  harness: Harness,
): string {
  if (harness === "codex") {
    return [
      `You're picking up the Hitch task "${task.title}".`,
      `Its file is at .hitch/${task.path}, relative to your current directory (the repo root).`,
      ``,
      `Read the task, keep the task status/progress current as you work, and start implementing it.`,
    ].join("\n");
  }

  return [
    `You're picking up the Hitch task "${task.title}".`,
    `Its file is at .hitch/${task.path}, relative to your current directory (the repo root).`,
    ``,
    `Read the task, keep the task status/progress current as you work, and start implementing it.`,
  ].join("\n");
}
