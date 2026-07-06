// Pure helpers for seed-then-upgrade task auto-titling. The desktop stamps a
// SEED title at creation (the first line of a capture); a generate-title command
// asks a cheap model for a better one, and the daemon rewrites task.md — but only
// if the on-disk title still equals that seed (titleGuardAllows). Any other value
// means the user (or an agent) renamed the task first, and their edit wins.
//
// Kept apart from chatTitles.ts because task titles are frontmatter scalars
// written back to disk, not chat display strings — the two just happen to share a
// length budget and the same "clamp with a trailing …" rule, so we borrow that
// constant to keep the surfaces reading consistently.

import { CHAT_TITLE_MAX_LENGTH } from "./chatTitles.js";

export const TASK_TITLE_MAX_LENGTH = CHAT_TITLE_MAX_LENGTH;

// The task body handed to the model is capped so a huge pasted task can't blow
// the prompt up; the first 8000 chars carry more than enough signal for a 3-8
// word title.
export const TITLE_PROMPT_MAX_CHARS = 8000;

// Plain text response, NOT --json-schema: the CLI's structured-output mode runs
// a multi-turn negotiation (measured 5 API round trips, ~8.5s) while a bare
// "reply with only the title" one-shot is a single turn (~2-3s).
const PROMPT_PREAMBLE = [
  "You write concise task titles for a developer's todo list.",
  "Reply with ONLY the title text on a single line, nothing else. Rules:",
  "- Title should summarize the task, not restate it verbatim.",
  "- Keep it short and specific (3-8 words).",
  "- Avoid quotes, filler, prefixes, and trailing punctuation.",
].join("\n");

// Build the -p prompt from the task body alone, capped. The body IS the verbatim
// capture text, and the seed the desktop stamped is itself derived from the
// body's first words — so passing the seed too would only duplicate them. The
// model titles the body directly.
export function buildTitlePrompt(body: string): string {
  const content = body.slice(0, TITLE_PROMPT_MAX_CHARS);
  return `${PROMPT_PREAMBLE}\n\nTask content:\n${content}`;
}

// Sanitize a model-produced title: first line only, strip wrapping quotes /
// backticks, collapse internal whitespace, then clamp to the shared max with a
// trailing "..." (mirrors normalizeChatTitle's clamp). Returns "" for empty /
// whitespace-only input so the caller can treat it as a generation failure.
export function sanitizeGeneratedTitle(raw: string | null | undefined): string {
  const firstLine = (raw ?? "").split(/\r?\n/)[0] ?? "";
  const unquoted = firstLine
    .trim()
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "");
  const normalized = unquoted.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= TASK_TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, TASK_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

// Extract the title from `claude -p --output-format json` output. The prompt
// asks for bare title text, so `result` holding the raw title is the expected
// path. We still check `structured_output` and a JSON-shaped `result` first,
// defensively — a model that returns `{"title": ...}` anyway shouldn't produce
// a title that literally starts with `{"title"`. Returns a sanitized title, or
// "" when nothing usable is present (a hard failure the caller reports).
export function titleFromCliResult(stdout: string): string {
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    return "";
  }
  if (typeof wrapper !== "object" || wrapper === null) return "";
  const obj = wrapper as Record<string, unknown>;

  const structured = obj.structured_output;
  if (
    structured &&
    typeof structured === "object" &&
    typeof (structured as Record<string, unknown>).title === "string"
  ) {
    return sanitizeGeneratedTitle((structured as Record<string, string>).title);
  }

  const result = obj.result;
  if (typeof result === "string") {
    try {
      const parsed = JSON.parse(result) as { title?: unknown };
      if (typeof parsed.title === "string") {
        return sanitizeGeneratedTitle(parsed.title);
      }
    } catch {
      // `result` wasn't JSON — treat it as the raw title text.
    }
    return sanitizeGeneratedTitle(result);
  }
  return "";
}

// The two small models Hitch can drive for auto-titling, and their CLI rails.
// codex (gpt-5.4-mini) is the default; claude (claude-haiku-4-5) is the alt. The
// value doubles as the model id passed to each CLI — the two happen to line up,
// which keeps modelForRail a plain lookup. Mirrors t3code's user-selectable
// text-generation model with a codex default.
export const TEXT_GENERATION_MODELS = [
  "gpt-5.4-mini",
  "claude-haiku-4-5",
] as const;

export type TextGenerationModel = (typeof TEXT_GENERATION_MODELS)[number];
export type TitleRail = "codex" | "claude";

export const DEFAULT_TEXT_GENERATION_MODEL: TextGenerationModel = "gpt-5.4-mini";

// A missing, corrupt, or unrecognized preference falls back to the codex default
// so behavior is deterministic regardless of what's on disk.
export function normalizeTextGenerationModel(
  value: unknown,
): TextGenerationModel {
  return value === "gpt-5.4-mini" || value === "claude-haiku-4-5"
    ? value
    : DEFAULT_TEXT_GENERATION_MODEL;
}

// claude-haiku-4-5 → the claude rail; everything else (the default included) →
// the codex rail.
export function railForModel(model: TextGenerationModel): TitleRail {
  return model === "claude-haiku-4-5" ? "claude" : "codex";
}

// The model id a rail actually invokes, recorded in the command result for
// diagnosability. Inverse of railForModel over the two supported models.
export function modelForRail(rail: TitleRail): TextGenerationModel {
  return rail === "claude" ? "claude-haiku-4-5" : "gpt-5.4-mini";
}

// The seed-guard invariant: apply a generated title ONLY when the on-disk title
// still equals the seed the desktop stamped at creation, or is empty/missing (a
// title the user cleared). Any other value means the task was renamed since, so
// generation must become a no-op — the human's rename outranks the machine's.
export function titleGuardAllows(
  currentTitle: string | null | undefined,
  seed: string,
): boolean {
  const current = (currentTitle ?? "").trim();
  if (current === "") return true;
  return current === seed.trim();
}
