type CronField = Set<number>;

export type SchedulePreset =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "hourly"; minute: number }
  | { kind: "custom"; cron: string };

interface ParsedCron {
  minutes: CronField;
  hours: CronField;
  daysOfMonth: CronField;
  months: CronField;
  daysOfWeek: CronField;
  restrictsDayOfMonth: boolean;
  restrictsDayOfWeek: boolean;
  rawFields: string[];
}

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function assertTimezone(timezone: string) {
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
    if (part.split("/").length > 2) {
      throw new Error(`${name} has invalid step syntax`);
    }
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`${name} step must be a positive integer`);
    }

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
      if (current < min || current > max) {
        throw new Error(`${name} value is out of range`);
      }
      allowed.add(normalize ? normalize(current) : current);
    }
  }
  return allowed;
}

export function parseCron(schedule: string): ParsedCron {
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
    rawFields: fields,
  };
}

export function validateSchedule(schedule: string, timezone: string) {
  assertTimezone(timezone);
  parseCron(schedule);
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

export function nextRunForScheduleState(
  schedule: string,
  timezone: string,
  enabled: boolean,
  after = Date.now(),
) {
  return enabled ? nextRunAfter(schedule, timezone, after) : undefined;
}

function assertClock(hour: number, minute: number) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("hour must be an integer from 0 to 23");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("minute must be an integer from 0 to 59");
  }
}

export function cronFromPreset(preset: SchedulePreset) {
  switch (preset.kind) {
    case "daily":
      assertClock(preset.hour, preset.minute);
      return `${preset.minute} ${preset.hour} * * *`;
    case "weekly":
      assertClock(preset.hour, preset.minute);
      if (
        !Number.isInteger(preset.dayOfWeek) ||
        preset.dayOfWeek < 0 ||
        preset.dayOfWeek > 6
      ) {
        throw new Error("dayOfWeek must be an integer from 0 to 6");
      }
      return `${preset.minute} ${preset.hour} * * ${preset.dayOfWeek}`;
    case "weekdays":
      assertClock(preset.hour, preset.minute);
      return `${preset.minute} ${preset.hour} * * 1-5`;
    case "hourly":
      assertClock(0, preset.minute);
      return `${preset.minute} * * * *`;
    case "custom":
      parseCron(preset.cron);
      return preset.cron.trim().replace(/\s+/g, " ");
  }
}

function singleValue(values: Set<number>) {
  return values.size === 1 ? [...values][0] : undefined;
}

function fieldList(values: Set<number>, labels?: string[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.map((value) => labels?.[value] ?? String(value)).join(", ");
}

function formatTime(hour: number, minute: number) {
  const suffix = hour < 12 ? "AM" : "PM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function scheduleToEnglish(schedule: string) {
  const cron = parseCron(schedule);
  const minute = singleValue(cron.minutes);
  const hour = singleValue(cron.hours);
  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] =
    cron.rawFields;

  if (
    minute !== undefined &&
    hour !== undefined &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "*"
  ) {
    return `Daily at ${formatTime(hour, minute)}`;
  }

  if (
    minute !== undefined &&
    hour !== undefined &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "1-5"
  ) {
    return `Every weekday at ${formatTime(hour, minute)}`;
  }

  const dayOfWeek = singleValue(cron.daysOfWeek);
  if (
    minute !== undefined &&
    hour !== undefined &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeek !== undefined
  ) {
    return `Weekly on ${DAY_NAMES[dayOfWeek]} at ${formatTime(hour, minute)}`;
  }

  if (
    minute !== undefined &&
    hourField === "*" &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "*"
  ) {
    return `Hourly at :${String(minute).padStart(2, "0")}`;
  }

  const everyNMinutes = minuteField.match(/^\*\/([1-9]\d*)$/);
  if (
    everyNMinutes &&
    hourField === "*" &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "*"
  ) {
    return `Every ${everyNMinutes[1]} minutes`;
  }

  const time =
    minute !== undefined && hour !== undefined
      ? `at ${formatTime(hour, minute)}`
      : `when minute is ${fieldList(cron.minutes)} and hour is ${fieldList(
          cron.hours,
        )}`;
  const dateParts = [];
  if (dayOfMonthField !== "*") {
    dateParts.push(`on day ${fieldList(cron.daysOfMonth)} of the month`);
  }
  if (monthField !== "*") {
    dateParts.push(`in ${fieldList(cron.months, [
      "",
      ...MONTH_NAMES,
    ])}`);
  }
  if (dayOfWeekField !== "*") {
    dateParts.push(`on ${fieldList(cron.daysOfWeek, DAY_NAMES)}`);
  }

  return `Custom schedule ${time}${
    dateParts.length ? `, ${dateParts.join(", ")}` : ""
  }`;
}
