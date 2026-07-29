// Launch catalogs for the delegate bar: the harnesses Hitch can drive, their
// model/effort ladders, the run environments, and the reusable kickoff prompts.
// All pure data plus small helpers over it — no React and no DOM beyond the
// localStorage guards in loadLastAgent/saveLastAgent/loadCustomPrompts.

import { PROMPT_TEMPLATE_FRAMING, PROMPT_VARIABLES } from "@hitch/shared";

// The coding agents Hitch can delegate to.
export type Harness = "claude-code" | "codex";

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
    { id: "cmux", label: "cmux (TUI)" },
    { id: "vscode", label: "VS Code extension" },
    { id: "cursor", label: "Cursor extension" },
  ],
};

export function environmentOptions(harness: Harness): EnvironmentOption[] {
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

const CODEX_GPT_5_6_REASONING: LaunchOption[] = [
  { id: "none", label: "None" },
  ...CODEX_REASONING,
  { id: "max", label: "Max" },
];

// Model ids are handed to the harness verbatim (e.g. `claude --model
// claude-opus-4-8`). Codex mirrors the visible app-server `model/list` catalog
// plus current OpenAI model docs when the Codex catalog lags a same-day model
// release; hidden models are intentionally excluded.
export const MODELS_BY_HARNESS: Record<Harness, ModelOption[]> = {
  "claude-code": [
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-5", label: "Opus 5", default: true },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
    { id: "claude-opus-4-7", label: "Opus 4.7" },
    { id: "claude-opus-4-6", label: "Opus 4.6" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  ],
  codex: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      defaultReasoning: "medium",
      reasoning: CODEX_GPT_5_6_REASONING,
    },
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      defaultReasoning: "medium",
      reasoning: CODEX_GPT_5_6_REASONING,
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      defaultReasoning: "medium",
      reasoning: CODEX_GPT_5_6_REASONING,
    },
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
  ].map((model) => ({
    ...model,
    reasoning: model.reasoning ?? CODEX_REASONING,
  })),
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

// A reusable kickoff prompt the user picks from the delegation dropdown.
//
// `body` is the COMPLETE prompt template — nothing is prepended to it at launch.
// That's the honesty contract: whatever is in the delegate bar's textarea is
// what the agent gets, byte for byte, once the server substitutes $TASK_TITLE /
// $TASK_BODY / $TASK_ID (server/src/prompt.ts). Templates keep the editable text
// short without hiding anything — the task body is already on screen above the
// bar, so restating it in the textarea would be noise, not transparency.
export interface StartingPrompt {
  id: string;
  name: string;
  body: string;
  // Short, plain-English summary shown beside the preset name in the minimized
  // delegate bar (the `body` is too long to show inline). Optional: built-ins
  // always set it; custom prompts may omit it and fall back to a truncated body
  // via `promptDescription`. Letting users author this is a follow-up — see the
  // prompt-manager settings UI.
  description?: string;
}

// The secondary line shown under a preset's name. Falls back to a one-line
// squashed/truncated `body` when a (custom) prompt has no authored description.
// The shared framing is stripped first: every template opens with the same
// header, so describing a prompt by its first 72 characters would describe all
// of them identically. What's left is the part that actually differs.
export function promptDescription(prompt: StartingPrompt): string {
  if (prompt.description?.trim()) return prompt.description.trim();
  const body = describableRemainder(prompt.body).trim().replace(/\s+/g, " ");
  return body.length > 72 ? `${body.slice(0, 71)}…` : body;
}

// The part of a template worth describing. An exact framing prefix is stripped
// (which also makes a framing-only draft describe as nothing, i.e. "no
// instructions yet"); otherwise fall back to the LAST paragraph, since an
// instruction stanza comes after the task in every shape we ship. The exact
// prefix alone wasn't enough: editing one word of the framing — or deleting the
// task id line, which the seeded draft rather invites — put every prompt back
// to describing itself with the same shared boilerplate.
function describableRemainder(body: string): string {
  if (body.startsWith(PROMPT_TEMPLATE_FRAMING)) {
    return body.slice(PROMPT_TEMPLATE_FRAMING.length);
  }
  const paragraphs = body.split(/\n\s*\n/).filter((p) => p.trim() !== "");
  return paragraphs.length > 0 ? paragraphs[paragraphs.length - 1] : "";
}

// A complete template: the shared framing (task title, body, id) followed by the
// stanza that says what to DO. Built-ins are assembled this way so the framing
// has exactly one definition, on the server, next to the resolver that
// substitutes it.
export function withPromptFraming(instruction: string): string {
  return `${PROMPT_TEMPLATE_FRAMING}\n\n${instruction}`;
}

// Curated built-in kickoff prompts. These ship in the app binary and are the
// same for everyone: they're never persisted, can't be edited or removed, and
// refresh with every app update. The delegation dropdown is composed as these
// followed by the user's custom prompts. The bodies live only here now — the
// main process knows the ids (BUILTIN_PROMPT_IDS, mirrored in main.ts) so it can
// strip any built-in a user previously had seeded into their stored library.
// Each body is a COMPLETE template: shared framing + one instruction stanza. The
// stanzas are unchanged from when a hidden preamble supplied the framing — they
// reference "this task" rather than a file.
export const BUILTIN_STARTING_PROMPTS: StartingPrompt[] = [
  {
    id: "default-execute",
    name: "Do the task.",
    description: "Reads the task and does what it asks",
    body: withPromptFraming("Read this task and do what it asks."),
  },
  {
    id: "think-through",
    name: "Help me think this through.",
    description: "Talks through the problem with you, no code yet",
    body: withPromptFraming(
      "Don't write any code yet. Help me reason through the task, question, or idea described here and organize my own thinking. Read the task and explore any relevant context, then push on it with me: ask clarifying questions, point out inconsistencies or risks I may have missed, and compare plausible approaches with your honest recommendation. The goal is to help me sharpen my judgment, not to produce a step-by-step plan or start implementation.",
    ),
  },
  {
    id: "refine-task",
    name: "Turn this into an agent-ready task.",
    description: "Interviews you, then rewrites the task as a spec",
    body: withPromptFraming(
      [
        "Don't start implementation yet. Help me turn this task into a clear, self-contained brief that a fresh agent with no context can execute confidently.",
        "First, investigate. Read the task description above and explore the repo for anything relevant: existing code, patterns, and the files this would likely touch.",
        'Then interview me. Ask your most important clarifying questions, and keep going until we share an unambiguous understanding of the goal, what "done" looks like, the scope boundaries, and any constraints.',
        "When we agree it's fully specified, rewrite the task's description so it stands on its own: goal, the relevant context and files you found, concrete acceptance criteria, and anything explicitly out of scope. Give me the finished description to review and apply to the task.",
      ].join("\n\n"),
    ),
  },
  {
    id: "investigate",
    name: "How hard would this be?",
    description: "Scopes the work and flags risks, no code",
    body: withPromptFraming(
      "Don't write any code. Read the task, explore the parts of the repo it would touch, and come back with a candid read on how hard it'd be to solve — the rough shape of the work, what's risky or uncertain, and any open questions.",
    ),
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

// Prompts saved before templates existed are instruction-only: they assumed a
// preamble would be prepended at launch. Nothing is prepended any more, so left
// alone they'd launch an agent with NO task context — silently, which is the
// worst way for this to break. A prompt that mentions no variable at all gets
// the framing put back.
//
// Migrated in place (persisted below) rather than on every read, so a user who
// later deletes the framing on purpose keeps their edit.
function migrateLegacyPrompt(prompt: StartingPrompt): StartingPrompt {
  const hasVariable = PROMPT_VARIABLES.some((name) =>
    prompt.body.includes(`$${name}`),
  );
  if (hasVariable || prompt.body.trim() === "") return prompt;
  return { ...prompt, body: withPromptFraming(prompt.body) };
}

// Read the user's custom prompts from the desktop bridge. Built-ins are not
// included — they live in BUILTIN_STARTING_PROMPTS and the dropdown concatenates
// the two. Outside Hitch Desktop (web, no bridge) there are no customs.
export async function loadCustomPrompts(): Promise<StartingPrompt[]> {
  const bridge = startingPromptsBridge();
  if (!bridge?.getStartingPrompts) return [];
  try {
    const stored = await bridge.getStartingPrompts();
    const migrated = stored.map(migrateLegacyPrompt);
    if (migrated.some((p, i) => p.body !== stored[i].body)) {
      // Fire-and-forget: the caller gets the migrated list either way, and a
      // failed write just means we migrate again next load.
      void saveCustomPrompts(migrated).catch(() => {});
    }
    return migrated;
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
