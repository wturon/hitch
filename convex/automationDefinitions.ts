import {
  nextRunForScheduleState,
  scheduleToEnglish,
  validateSchedule,
} from "./automationSchedules";

export const AUTOMATION_DEFINITION_RE = /^automations\/([^/]+)\/index\.md$/;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_HARNESS = "codex";

export interface AutomationProjectionInput {
  path: string;
  content: string;
  deleted: boolean;
  previous?: {
    lastScheduledAt?: number;
    lastRunId?: string;
  } | null;
  now?: number;
}

export interface AutomationDefinitionProjection {
  automationPath: string;
  slug: string;
  name: string;
  enabled: boolean;
  schedule: string;
  scheduleDescription: string;
  timezone: string;
  harness: string;
  model?: string;
  effort?: string;
  prompt: string;
  lastScheduledAt?: number;
  nextRunAt?: number;
  lastRunId?: string;
  validationError?: string;
  deleted: boolean;
}

function parseFrontmatter(content: string) {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    frontmatter[key] = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: match[2] };
}

function truthy(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "on", "1", "enabled"].includes(normalized)) return true;
  if (["false", "no", "off", "0", "disabled"].includes(normalized)) return false;
  throw new Error(`enabled must be true or false`);
}

function scalar(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function projectAutomationDefinition(
  input: AutomationProjectionInput,
): AutomationDefinitionProjection | null {
  const match = input.path.match(AUTOMATION_DEFINITION_RE);
  if (!match) return null;

  const automationPath = input.path;
  const slug = match[1];
  if (input.deleted) {
    return {
      automationPath,
      slug,
      name: slug,
      enabled: false,
      schedule: "",
      scheduleDescription: "",
      timezone: DEFAULT_TIMEZONE,
      harness: DEFAULT_HARNESS,
      prompt: "",
      lastScheduledAt: input.previous?.lastScheduledAt,
      lastRunId: input.previous?.lastRunId,
      deleted: true,
    };
  }

  const { frontmatter, body } = parseFrontmatter(input.content);
  const name = scalar(frontmatter.name) ?? scalar(frontmatter.title) ?? slug;
  const schedule = scalar(frontmatter.schedule);
  const timezone = scalar(frontmatter.timezone) ?? DEFAULT_TIMEZONE;
  const harness = scalar(frontmatter.harness) ?? DEFAULT_HARNESS;
  const model = scalar(frontmatter.model);
  const effort = scalar(frontmatter.effort);
  let enabled = false;
  let nextRunAt: number | undefined;
  let scheduleDescription = "";
  let validationError: string | undefined;

  try {
    if ((scalar(frontmatter.type) ?? "automation") !== "automation") {
      throw new Error(`type must be automation`);
    }
    enabled = truthy(frontmatter.enabled, true);
    if (!schedule) throw new Error(`schedule is required`);
    if (!body.trim()) throw new Error(`prompt is required`);
    validateSchedule(schedule, timezone);
    scheduleDescription = scheduleToEnglish(schedule);
    nextRunAt = nextRunForScheduleState(schedule, timezone, enabled, input.now);
  } catch (error) {
    enabled = false;
    validationError =
      error instanceof Error ? error.message : "automation definition is invalid";
  }

  return {
    automationPath,
    slug,
    name,
    enabled,
    schedule: schedule ?? "",
    scheduleDescription,
    timezone,
    harness,
    model,
    effort,
    prompt: body.trim(),
    lastScheduledAt: input.previous?.lastScheduledAt,
    nextRunAt,
    lastRunId: input.previous?.lastRunId,
    validationError,
    deleted: false,
  };
}
