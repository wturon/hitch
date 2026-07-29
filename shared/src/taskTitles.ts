export const TEXT_GENERATION_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.4-mini",
  "claude-haiku-4-5",
] as const;

export type TextGenerationModel = (typeof TEXT_GENERATION_MODELS)[number];

export const DEFAULT_TEXT_GENERATION_MODEL: TextGenerationModel =
  "gpt-5.6-luna";

export function isTextGenerationModel(
  value: unknown,
): value is TextGenerationModel {
  return (
    typeof value === "string" &&
    TEXT_GENERATION_MODELS.some((model) => model === value)
  );
}

// Additive title metadata derived from the first non-empty body line. The body
// itself is never changed or carved up.
export function deriveTitleFromBody(body: string, maxWords = 6): string {
  const firstLine =
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const cleaned = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").filter(Boolean).slice(0, maxWords).join(" ");
}

export function taskTitleSeed(body: string): string {
  return deriveTitleFromBody(body) || "Untitled";
}

export function isAutoTitlePending(task: {
  title: string;
  autoTitleSeed?: string | null;
}): boolean {
  return task.autoTitleSeed != null && task.title === task.autoTitleSeed;
}
