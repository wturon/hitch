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

// The task content (seed + body) handed to the model is capped so a huge pasted
// task can't blow the prompt up; the first 8000 chars carry more than enough
// signal for a 3-8 word title.
export const TITLE_PROMPT_MAX_CHARS = 8000;

const PROMPT_PREAMBLE = [
  "You write concise task titles for a developer's todo list.",
  "Return a JSON object with key: title. Rules:",
  "- Title should summarize the task, not restate it verbatim.",
  "- Keep it short and specific (3-8 words).",
  "- Avoid quotes, filler, prefixes, and trailing punctuation.",
].join("\n");

// Build the -p prompt from the seed title + task body, capped. The seed leads so
// the model still anchors on the user's own words when the body is thin.
export function buildTitlePrompt(seed: string, body: string): string {
  const content = `${seed}\n${body}`.slice(0, TITLE_PROMPT_MAX_CHARS);
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

// Extract the title from `claude -p --output-format json` output. The wrapper
// puts the structured result in `structured_output` (already parsed, when a
// --json-schema was supplied) and a JSON string in `result`. We try the parsed
// field first, then parse `result` as `{title}`, then fall back to treating
// `result` as the raw title. Returns a sanitized title, or "" when nothing usable
// is present (a hard failure the caller reports).
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
