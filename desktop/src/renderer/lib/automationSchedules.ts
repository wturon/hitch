export type ScheduleCadence = "daily" | "weekly" | "weekdays" | "hourly" | "custom";

export interface ScheduleBuilderValue {
  cadence: ScheduleCadence;
  cron: string;
  timezone: string;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  rawFields: string[];
}

const DAY_NAMES = [
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
    throw new Error("timezone must be a valid IANA timezone");
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
    throw new Error("schedule must be a 5-field cron expression");
  }
  return {
    minutes: parseCronField(fields[0], 0, 59, "minute"),
    hours: parseCronField(fields[1], 0, 23, "hour"),
    daysOfMonth: parseCronField(fields[2], 1, 31, "day of month"),
    months: parseCronField(fields[3], 1, 12, "month"),
    daysOfWeek: parseCronField(fields[4], 0, 7, "day of week", (day) =>
      day === 7 ? 0 : day,
    ),
    rawFields: fields,
  };
}

export function validateSchedule(schedule: string, timezone: string) {
  assertTimezone(timezone);
  parseCron(schedule);
}

function assertClock(hour: number, minute: number) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("hour must be an integer from 0 to 23");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("minute must be an integer from 0 to 59");
  }
}

export function cronFromBuilder(value: ScheduleBuilderValue) {
  switch (value.cadence) {
    case "daily":
      assertClock(value.hour, value.minute);
      return `${value.minute} ${value.hour} * * *`;
    case "weekly":
      assertClock(value.hour, value.minute);
      if (!Number.isInteger(value.dayOfWeek) || value.dayOfWeek < 0 || value.dayOfWeek > 6) {
        throw new Error("day must be Sunday through Saturday");
      }
      return `${value.minute} ${value.hour} * * ${value.dayOfWeek}`;
    case "weekdays":
      assertClock(value.hour, value.minute);
      return `${value.minute} ${value.hour} * * 1-5`;
    case "hourly":
      assertClock(0, value.minute);
      return `${value.minute} * * * *`;
    case "custom":
      parseCron(value.cron);
      return value.cron.trim().replace(/\s+/g, " ");
  }
}

function singleValue(values: Set<number>) {
  return values.size === 1 ? [...values][0] : undefined;
}

function fieldList(values: Set<number>, labels?: string[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.map((value) => labels?.[value] ?? String(value)).join(", ");
}

export function formatScheduleTime(hour: number, minute: number) {
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
    return `Daily at ${formatScheduleTime(hour, minute)}`;
  }

  if (
    minute !== undefined &&
    hour !== undefined &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeekField === "1-5"
  ) {
    return `Every weekday at ${formatScheduleTime(hour, minute)}`;
  }

  const dayOfWeek = singleValue(cron.daysOfWeek);
  if (
    minute !== undefined &&
    hour !== undefined &&
    dayOfMonthField === "*" &&
    monthField === "*" &&
    dayOfWeek !== undefined
  ) {
    return `Weekly on ${DAY_NAMES[dayOfWeek]} at ${formatScheduleTime(hour, minute)}`;
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
      ? `at ${formatScheduleTime(hour, minute)}`
      : `when minute is ${fieldList(cron.minutes)} and hour is ${fieldList(cron.hours)}`;
  const dateParts = [];
  if (dayOfMonthField !== "*") {
    dateParts.push(`on day ${fieldList(cron.daysOfMonth)} of the month`);
  }
  if (monthField !== "*") {
    dateParts.push(`in ${fieldList(cron.months, ["", ...MONTH_NAMES])}`);
  }
  if (dayOfWeekField !== "*") {
    dateParts.push(`on ${fieldList(cron.daysOfWeek, DAY_NAMES)}`);
  }

  return `Custom schedule ${time}${dateParts.length ? `, ${dateParts.join(", ")}` : ""}`;
}

export function scheduleBuilderFromCron(
  cronValue: string,
  timezone: string,
): ScheduleBuilderValue {
  const fallback = {
    cadence: "custom" as const,
    cron: cronValue,
    timezone,
    hour: 9,
    minute: 0,
    dayOfWeek: 1,
  };

  try {
    const cron = parseCron(cronValue);
    const minute = singleValue(cron.minutes);
    const hour = singleValue(cron.hours);
    const [, hourField, dayOfMonthField, monthField, dayOfWeekField] = cron.rawFields;

    if (
      minute !== undefined &&
      hour !== undefined &&
      dayOfMonthField === "*" &&
      monthField === "*" &&
      dayOfWeekField === "*"
    ) {
      return { ...fallback, cadence: "daily", hour, minute };
    }
    if (
      minute !== undefined &&
      hour !== undefined &&
      dayOfMonthField === "*" &&
      monthField === "*" &&
      dayOfWeekField === "1-5"
    ) {
      return { ...fallback, cadence: "weekdays", hour, minute };
    }
    const dayOfWeek = singleValue(cron.daysOfWeek);
    if (
      minute !== undefined &&
      hour !== undefined &&
      dayOfMonthField === "*" &&
      monthField === "*" &&
      dayOfWeek !== undefined
    ) {
      return { ...fallback, cadence: "weekly", hour, minute, dayOfWeek };
    }
    if (
      minute !== undefined &&
      hourField === "*" &&
      dayOfMonthField === "*" &&
      monthField === "*" &&
      dayOfWeekField === "*"
    ) {
      return { ...fallback, cadence: "hourly", minute };
    }
  } catch {
    return fallback;
  }

  return fallback;
}

export function scheduleHelper(value: ScheduleBuilderValue) {
  try {
    const cron = cronFromBuilder(value);
    validateSchedule(cron, value.timezone);
    return { ok: true as const, cron, text: scheduleToEnglish(cron) };
  } catch (error) {
    return {
      ok: false as const,
      cron: value.cron,
      text: error instanceof Error ? error.message : "Invalid schedule",
    };
  }
}

export { DAY_NAMES };
