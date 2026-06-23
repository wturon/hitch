import type { FunctionReturnType } from "convex/server";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { parseFrontmatter, setFrontmatterKeys, splitFrontmatter } from "./frontmatter";
import { uniqueSlug } from "./tasks";

export type AutomationQuery = FunctionReturnType<typeof api.automations.listAutomations>;
export type AutomationRecord = AutomationQuery[number];
export type AutomationRunsQuery = FunctionReturnType<typeof api.automations.listRuns>;
export type AutomationRunRecord = AutomationRunsQuery[number];

export interface AutomationFileDoc {
  _id: Id<"files">;
  path: string;
  content: string;
  deleted: boolean;
  updatedAt: number;
}

export interface AutomationDefinitionDraft {
  name: string;
  enabled: boolean;
  schedule: string;
  timezone: string;
  harness: string;
  model?: string;
  effort?: string;
  prompt: string;
}

const AUTOMATION_RE = /^automations\/([^/]+)\/index\.md$/;

export function automationSlug(path: string): string | null {
  return path.match(AUTOMATION_RE)?.[1] ?? null;
}

export function automationPath(slug: string): string {
  return `automations/${slug}/index.md`;
}

export function automationFileForPath(
  files: AutomationFileDoc[],
  path: string,
): AutomationFileDoc | null {
  return files.find((file) => file.path === path && !file.deleted) ?? null;
}

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function defaultAutomationContent(name: string, timezone = localTimezone()) {
  return [
    "---",
    `name: ${name}`,
    "type: automation",
    "enabled: true",
    "schedule: 0 9 * * *",
    `timezone: ${timezone}`,
    "harness: codex",
    "model: gpt-5.5",
    "effort: medium",
    "---",
    "",
  ].join("\n");
}

export function draftFromContent(content: string): AutomationDefinitionDraft {
  const { frontmatter, body } = parseFrontmatter(content);
  return {
    name: frontmatter.name || frontmatter.title || "Untitled automation",
    enabled: frontmatter.enabled !== "false",
    schedule: frontmatter.schedule || "0 9 * * *",
    timezone: frontmatter.timezone || localTimezone(),
    harness: frontmatter.harness || "codex",
    model: frontmatter.model,
    effort: frontmatter.effort,
    prompt: body,
  };
}

export function contentFromDraft(
  currentContent: string,
  draft: AutomationDefinitionDraft,
): string {
  const withFrontmatter = setFrontmatterKeys(currentContent, {
    name: draft.name,
    title: undefined,
    type: "automation",
    enabled: String(draft.enabled),
    schedule: draft.schedule,
    timezone: draft.timezone,
    harness: draft.harness,
    model: draft.model,
    effort: draft.effort,
  });
  const { frontmatterBlock } = splitFrontmatter(withFrontmatter);
  return `${frontmatterBlock}${draft.prompt}`;
}

export function nextAutomationSlug(
  files: AutomationFileDoc[],
  name: string,
): string {
  return uniqueSlug(
    name || "Untitled automation",
    new Set(
      files
        .map((file) => (file.deleted ? null : automationSlug(file.path)))
        .filter((slug): slug is string => slug !== null),
    ),
  );
}
