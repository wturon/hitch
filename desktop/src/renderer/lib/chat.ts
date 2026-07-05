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
//
// T3Code (experimental) note: for the `t3code` environment, `chat-id` holds the
// T3Code *threadId* (the id Hitch acts on for focus/status), not the Claude
// session UUID. The daemon also writes `chat-t3-thread-id` (mirror) and
// `chat-t3-environment-id` (the global env id needed to build the focus URL).

import type { Frontmatter } from "./frontmatter";
import { setFrontmatterKeys } from "./frontmatter";
import type { Harness } from "./chatModel";
import {
  CHAT_REQUEST_ERROR_KEY,
  CHAT_REQUEST_HARNESS_KEY,
  CHAT_REQUEST_ID_KEY,
  CHAT_REQUEST_KEY,
  HARNESSES,
} from "./chatModel";

// The pure parsing/derivation model (Harness, ChatRef, ChatStatus + aliases,
// the delegation-request rules, parseChatRef/parseChatStatus/…) lives in
// ./chatModel so the Todos derivation core stays importable from Convex (see
// the purity contract there). Re-exported wholesale: every existing consumer
// keeps importing these names from "@/lib/chat" unchanged.
export * from "./chatModel";

export function harnessLabel(harness: Harness): string {
  return harness === "codex" ? "Codex" : "Claude Code";
}

// Where a harness runs and is presented to the user. Today there is one
// environment per harness (the daemon derives it from the harness), but the
// settings UI models this axis explicitly so future environments (e.g. the VS Code
// extension) slot in without reshaping the mental model. Keep in sync with the
// daemon's launcher registry.
export type Environment = "cmux" | "codex-app" | "vscode" | "cursor" | "t3code";

export interface EnvironmentOption {
  id: Environment;
  label: string;
}

export const T3CODE_BLOCKED_REASON =
  "blocked until programmatic chat focusing is enabled by the maintainers";

export const ENVIRONMENTS_BY_HARNESS: Record<Harness, EnvironmentOption[]> = {
  "claude-code": [
    { id: "cmux", label: "cmux (TUI)" },
    { id: "vscode", label: "VS Code extension" },
    { id: "cursor", label: "Cursor extension" },
  ],
  codex: [
    { id: "codex-app", label: "Codex app" },
    { id: "cmux", label: "cmux (TUI)" },
    { id: "vscode", label: "VS Code extension" },
    { id: "cursor", label: "Cursor extension" },
  ],
};

// T3Code remains in the Environment type so old task metadata can be read, but
// it is intentionally absent from selectable options until upstream supports
// programmatic chat focusing.
export function environmentOptions(
  harness: Harness,
  _opts?: { experimentalT3Code?: boolean },
): EnvironmentOption[] {
  return ENVIRONMENTS_BY_HARNESS[harness];
}

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
    case "t3code":
      return "T3Code (experimental)";
    default:
      return "cmux (TUI)";
  }
}

export function isEnvironment(value: string): value is Environment {
  return (
    value === "cmux" ||
    value === "codex-app" ||
    value === "vscode" ||
    value === "cursor" ||
    value === "t3code"
  );
}

// Additional launch parameters the user can set before kicking off a harness:
// which model to run and how much reasoning/effort to spend. Both are start-time
// only — we pass them on the spawn command and let the harness own them after
// that, so they are never persisted to the task's frontmatter. Keep ids in sync
// with the flags the daemon passes (`claude --model/--effort`, codex
// `turn/start`).
export interface LaunchOption {
  id: string;
  label: string;
}

interface ModelOption extends LaunchOption {
  defaultReasoning?: string;
  reasoning?: LaunchOption[];
  // Marks the harness's default model. When absent, the first entry wins, so
  // list order and default are decoupled (e.g. Fable 5 sits atop the Claude
  // list but Opus 4.8 stays the default).
  default?: boolean;
}

const CLAUDE_REASONING: LaunchOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "xHigh" },
  { id: "max", label: "Max" },
];

const CODEX_REASONING: LaunchOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "xHigh" },
];

// Model ids are handed to the harness verbatim (e.g. `claude --model
// claude-opus-4-8`). Codex mirrors the visible app-server `model/list` catalog
// from codex-cli 0.137.0; hidden models are intentionally excluded.
export const MODELS_BY_HARNESS: Record<Harness, ModelOption[]> = {
  "claude-code": [
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8", default: true },
    { id: "claude-opus-4-7", label: "Opus 4.7" },
    { id: "claude-opus-4-6", label: "Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  codex: [
    { id: "gpt-5.5", label: "GPT-5.5", defaultReasoning: "medium" },
    { id: "gpt-5.4", label: "GPT-5.4", defaultReasoning: "medium" },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      defaultReasoning: "medium",
    },
    {
      id: "gpt-5.3-codex-spark",
      label: "GPT-5.3 Codex Spark",
      defaultReasoning: "high",
    },
  ].map((model) => ({ ...model, reasoning: CODEX_REASONING })),
};

// Reasoning/effort ladders. Claude maps to `claude --effort`; Codex maps to
// app-server `turn/start` effort or CLI `model_reasoning_effort`.
export const REASONING_BY_HARNESS: Record<Harness, LaunchOption[]> = {
  "claude-code": CLAUDE_REASONING,
  codex: CODEX_REASONING,
};

export function defaultModel(harness: Harness): string {
  const models = MODELS_BY_HARNESS[harness];
  return (models.find((m) => m.default) ?? models[0]).id;
}

export function reasoningOptions(
  harness: Harness,
  modelId?: string,
): LaunchOption[] {
  return (
    MODELS_BY_HARNESS[harness].find((m) => m.id === modelId)?.reasoning ??
    REASONING_BY_HARNESS[harness]
  );
}

export function defaultReasoning(harness: Harness, modelId?: string): string {
  return (
    MODELS_BY_HARNESS[harness].find((m) => m.id === modelId)?.defaultReasoning ??
    (harness === "codex" ? "medium" : "high")
  );
}

export function modelLabel(harness: Harness, id: string): string {
  return MODELS_BY_HARNESS[harness].find((m) => m.id === id)?.label ?? id;
}

// The (harness, model, effort) triple the delegate bar launches with. Persisted
// as one blob so the bar reopens on the user's last choice instead of a hardcoded
// default — switching harness then effort remembers the whole combination.
export interface AgentChoice {
  harness: Harness;
  model: string;
  effort: string;
}

const LAST_AGENT_KEY = "hitch:last-agent";

export function defaultAgentChoice(): AgentChoice {
  const harness: Harness = "codex";
  const model = defaultModel(harness);
  return { harness, model, effort: defaultReasoning(harness, model) };
}

// Read the last-used agent from localStorage, validating every field against the
// current harness/model/effort catalog — a build that dropped a model or renamed
// an effort must never seed the bar with a stale value, so each unknown piece
// falls back to its default (and an unknown harness resets the whole triple).
export function loadLastAgent(): AgentChoice {
  if (typeof window === "undefined") return defaultAgentChoice();
  try {
    const raw = window.localStorage.getItem(LAST_AGENT_KEY);
    if (!raw) return defaultAgentChoice();
    const parsed = JSON.parse(raw) as Partial<AgentChoice>;
    const harness = HARNESSES.includes(parsed.harness as Harness)
      ? (parsed.harness as Harness)
      : defaultAgentChoice().harness;
    const model = MODELS_BY_HARNESS[harness].some((m) => m.id === parsed.model)
      ? (parsed.model as string)
      : defaultModel(harness);
    const effort = reasoningOptions(harness, model).some(
      (r) => r.id === parsed.effort,
    )
      ? (parsed.effort as string)
      : defaultReasoning(harness, model);
    return { harness, model, effort };
  } catch {
    return defaultAgentChoice();
  }
}

export function saveLastAgent(choice: AgentChoice): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_AGENT_KEY, JSON.stringify(choice));
  } catch {
    // Private-mode / quota failures are non-fatal — we just don't remember.
  }
}

export function reasoningLabel(
  harness: Harness,
  id: string,
  modelId?: string,
): string {
  return reasoningOptions(harness, modelId).find((r) => r.id === id)?.label ?? id;
}

// Claude run inside an editor extension can't accept model/effort at launch —
// the extension owns them — so the compose UI disables those controls for that
// (harness, environment) pair and points the user at the editor instead.
export function honorsLaunchParams(
  harness: Harness,
  environment: Environment | undefined,
): boolean {
  return !(
    harness === "claude-code" &&
    (environment === "vscode" || environment === "cursor")
  );
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
    "chat-env": undefined,
    "chat-t3-thread-id": undefined,
    "chat-t3-environment-id": undefined,
    [CHAT_REQUEST_KEY]: undefined,
    [CHAT_REQUEST_HARNESS_KEY]: undefined,
    [CHAT_REQUEST_ID_KEY]: undefined,
    [CHAT_REQUEST_ERROR_KEY]: undefined,
  });
}

// A reusable kickoff instruction the user picks from the delegation dropdown.
// `body` is the user-authored instruction; `includeTaskRef` controls whether the
// dynamic task-reference preamble (task name + file path) is prepended at launch.
// The preamble is never stored — it's interpolated against the live task here in
// the renderer, so prompts stay portable and the context can be kept lean.
export interface StartingPrompt {
  id: string;
  name: string;
  body: string;
  includeTaskRef: boolean;
  // Short, plain-English summary shown beside the preset name in the minimized
  // delegate bar (the `body` is too long to show inline). Optional: built-ins
  // always set it; custom prompts may omit it and fall back to a truncated body
  // via `promptDescription`. Letting users author this is a follow-up — see the
  // prompt-manager settings UI.
  description?: string;
}

// The secondary line shown under a preset's name. Falls back to a one-line
// squashed/truncated `body` when a (custom) prompt has no authored description.
export function promptDescription(prompt: StartingPrompt): string {
  if (prompt.description?.trim()) return prompt.description.trim();
  const body = prompt.body.trim().replace(/\s+/g, " ");
  return body.length > 72 ? `${body.slice(0, 71)}…` : body;
}

// The dynamic preamble that orients the agent to the task it's picking up. The
// daemon links the session before the first model turn, so the agent can focus on
// the task instead of introspecting its own session id.
export function taskRefPreamble(task: { title: string; path: string }): string {
  return [
    `You're picking up the Hitch task "${task.title}".`,
    `Its file is at .hitch/${task.path}, relative to your current project folder.`,
  ].join("\n");
}

// Assemble the full seed prompt a preset produces for a given task: the optional
// task-reference preamble followed by the preset body.
export function buildStartPrompt(
  prompt: Pick<StartingPrompt, "body" | "includeTaskRef">,
  task: { title: string; path: string },
): string {
  const body = prompt.body.trim();
  if (!prompt.includeTaskRef) return body;
  const preamble = taskRefPreamble(task);
  return body ? `${preamble}\n\n${body}` : preamble;
}

// Curated built-in kickoff prompts. These ship in the app binary and are the
// same for everyone: they're never persisted, can't be edited or removed, and
// refresh with every app update. The delegation dropdown is composed as these
// followed by the user's custom prompts. The bodies live only here now — the
// main process knows the ids (BUILTIN_PROMPT_IDS, mirrored in main.ts) so it can
// strip any built-in a user previously had seeded into their stored library.
export const BUILTIN_STARTING_PROMPTS: StartingPrompt[] = [
  {
    id: "default-execute",
    name: "Do the task.",
    description: "Reads the task and does what it asks",
    body: "Read this task and do what it asks.",
    includeTaskRef: true,
  },
  {
    id: "think-through",
    name: "Help me think this through.",
    description: "Talks through the problem with you, no code yet",
    body: "Don't write any code yet. Help me reason through the task, question, or idea described here and organize my own thinking. Read the task and explore any relevant context, then push on it with me: ask clarifying questions, point out inconsistencies or risks I may have missed, and compare plausible approaches with your honest recommendation. The goal is to help me sharpen my judgment, not to produce a step-by-step plan or start implementation.",
    includeTaskRef: true,
  },
  {
    id: "refine-task",
    name: "Turn this into an agent-ready task.",
    description: "Interviews you, then rewrites the task as a spec",
    body: [
      "Don't start implementation yet. Help me turn this task into a clear, self-contained brief that a fresh agent with no context can execute confidently.",
      "First, investigate. Read the task body and explore the repo for anything relevant: existing code, patterns, and the files this would likely touch.",
      'Then interview me. Ask your most important clarifying questions, and keep going until we share an unambiguous understanding of the goal, what "done" looks like, the scope boundaries, and any constraints.',
      "When we agree it's fully specified, rewrite the body of the task file referenced above so it stands on its own: goal, the relevant context and files you found, concrete acceptance criteria, and anything explicitly out of scope. Leave the frontmatter untouched, and confirm when you've written it.",
    ].join("\n\n"),
    includeTaskRef: true,
  },
  {
    id: "investigate",
    name: "How hard would this be?",
    description: "Scopes the work and flags risks, no code",
    body: "Don't write any code. Read the task, explore the parts of the repo it would touch, and come back with a candid read on how hard it'd be to solve — the rough shape of the work, what's risky or uncertain, and any open questions.",
    includeTaskRef: true,
  },
];

// Ids of the built-in prompts. Custom prompts are kept disjoint from these (a
// custom prompt can never reuse a built-in id), so the two lists never collide
// in the dropdown. Keep in sync with the mirror in main.ts.
export const BUILTIN_PROMPT_IDS: ReadonlySet<string> = new Set(
  BUILTIN_STARTING_PROMPTS.map((p) => p.id),
);

interface StartingPromptsBridge {
  getStartingPrompts?: () => Promise<StartingPrompt[]>;
  setStartingPrompts?: (prompts: StartingPrompt[]) => Promise<StartingPrompt[]>;
}

function startingPromptsBridge(): StartingPromptsBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { hitchDaemon?: StartingPromptsBridge })
    .hitchDaemon;
}

// Read the user's custom prompts from the desktop bridge. Built-ins are not
// included — they live in BUILTIN_STARTING_PROMPTS and the dropdown concatenates
// the two. Outside Hitch Desktop (web, no bridge) there are no customs.
export async function loadCustomPrompts(): Promise<StartingPrompt[]> {
  const bridge = startingPromptsBridge();
  if (!bridge?.getStartingPrompts) return [];
  try {
    return await bridge.getStartingPrompts();
  } catch {
    return [];
  }
}

// Persist the user's custom prompts. The main process rejects any built-in id,
// so callers don't have to filter them out here. Returns the canonical stored
// list (or the input unchanged when there's no bridge to write to).
export async function saveCustomPrompts(
  prompts: StartingPrompt[],
): Promise<StartingPrompt[]> {
  const bridge = startingPromptsBridge();
  if (!bridge?.setStartingPrompts) return prompts;
  return bridge.setStartingPrompts(prompts);
}
