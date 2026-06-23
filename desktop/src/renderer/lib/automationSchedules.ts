import {
  DAY_NAMES,
  cronFromPreset,
  parseCron,
  scheduleToEnglish,
  validateSchedule,
  type SchedulePreset,
} from "@convex/automationSchedules";

export type ScheduleCadence = SchedulePreset["kind"];

export interface ScheduleBuilderValue {
  cadence: ScheduleCadence;
  cron: string;
  timezone: string;
  hour: number;
  minute: number;
  dayOfWeek: number;
}

export function cronFromBuilder(value: ScheduleBuilderValue) {
  const preset: SchedulePreset =
    value.cadence === "custom"
      ? { kind: "custom", cron: value.cron }
      : value.cadence === "hourly"
        ? { kind: "hourly", minute: value.minute }
        : value.cadence === "weekly"
          ? {
              kind: "weekly",
              dayOfWeek: value.dayOfWeek,
              hour: value.hour,
              minute: value.minute,
            }
          : value.cadence === "weekdays"
            ? { kind: "weekdays", hour: value.hour, minute: value.minute }
            : { kind: "daily", hour: value.hour, minute: value.minute };

  return cronFromPreset(preset);
}

function singleValue(values: Set<number>) {
  return values.size === 1 ? [...values][0] : undefined;
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
