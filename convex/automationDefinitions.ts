export const AUTOMATION_DEFINITION_RE = /^automations\/([^/]+)\/index\.md$/;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_HARNESS = "codex";

type CronField = Set<number>;

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

interface ParsedCron {
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
  restrictsDayOfMonth: boolean;
  restrictsDayOfWeek: boolean;
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

function assertTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`timezone must be a valid IANA timezone`);
  }
}

function parseCronField(
  value: string,
  min: number,
  max: number,
  name: string,
  normalize?: (value: number) => number,
) {
  const allowed = new Set<number>();
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part) throw new Error(`${name} has an empty segment`);
    const [rangePart, stepPart] = part.split("/");
    if (part.split("/").length > 2) throw new Error(`${name} has invalid step syntax`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${name} step must be a positive integer`);

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      start = Number(rawStart);
      end = Number(rawEnd);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        throw new Error(`${name} range is invalid`);
      }
    } else {
      start = Number(rangePart);
      end = start;
      if (!Number.isInteger(start)) throw new Error(`${name} value is invalid`);
    }

    for (let current = start; current <= end; current += step) {
      if (current < min || current > max) throw new Error(`${name} value is out of range`);
      allowed.add(normalize ? normalize(current) : current);
    }
  }
  return allowed;
}

function parseCron(schedule: string): ParsedCron {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`schedule must be a 5-field cron expression`);
  }
  return {
    minutes: parseCronField(fields[0], 0, 59, "minute"),
    hours: parseCronField(fields[1], 0, 23, "hour"),
    daysOfMonth: parseCronField(fields[2], 1, 31, "day of month"),
    months: parseCronField(fields[3], 1, 12, "month"),
    daysOfWeek: parseCronField(fields[4], 0, 7, "day of week", (day) =>
      day === 7 ? 0 : day,
    ),
    restrictsDayOfMonth: fields[2] !== "*",
    restrictsDayOfWeek: fields[4] !== "*",
  };
}

function zonedParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    dayOfWeek: new Date(
      Date.UTC(parts.year, parts.month - 1, parts.day),
    ).getUTCDay(),
  };
}

function cronMatches(cron: ParsedCron, date: Date, timezone: string) {
  const parts = zonedParts(date, timezone);
  const monthMatches = cron.months.has(parts.month);
  const timeMatches =
    cron.minutes.has(parts.minute) && cron.hours.has(parts.hour);
  if (!monthMatches || !timeMatches) return false;

  const domMatches = cron.daysOfMonth.has(parts.day);
  const dowMatches = cron.daysOfWeek.has(parts.dayOfWeek);
  if (cron.restrictsDayOfMonth && cron.restrictsDayOfWeek) {
    return domMatches || dowMatches;
  }
  return domMatches && dowMatches;
}

export function nextRunAfter(
  schedule: string,
  timezone: string,
  now = Date.now(),
) {
  const cron = parseCron(schedule);
  assertTimezone(timezone);

  const minuteMs = 60 * 1000;
  let candidate = Math.floor(now / minuteMs) * minuteMs + minuteMs;
  const end = now + 366 * 24 * 60 * minuteMs;
  while (candidate <= end) {
    if (cronMatches(cron, new Date(candidate), timezone)) return candidate;
    candidate += minuteMs;
  }
  throw new Error(`schedule has no run in the next 366 days`);
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
  let validationError: string | undefined;

  try {
    if ((scalar(frontmatter.type) ?? "automation") !== "automation") {
      throw new Error(`type must be automation`);
    }
    enabled = truthy(frontmatter.enabled, true);
    if (!schedule) throw new Error(`schedule is required`);
    assertTimezone(timezone);
    parseCron(schedule);
    if (enabled) {
      nextRunAt = nextRunAfter(schedule, timezone, input.now);
    }
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
