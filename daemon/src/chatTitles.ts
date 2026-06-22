export type ChatTitleHarness = "codex" | "claude-code";

export const CHAT_TITLE_MAX_LENGTH = 72;

export function untitledChatTitle(harness: ChatTitleHarness): string {
  return harness === "codex"
    ? "Untitled Codex chat"
    : "Untitled Claude Code chat";
}

export function normalizeChatTitle(
  value: string | null | undefined,
  harness: ChatTitleHarness,
): string {
  const normalized = value?.replace(/\s+/g, " ").trim() || untitledChatTitle(harness);
  if (normalized.length <= CHAT_TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, CHAT_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

export function titleFromInitialPrompt(
  prompt: string | null | undefined,
  harness: ChatTitleHarness,
): string {
  return normalizeChatTitle(prompt, harness);
}
