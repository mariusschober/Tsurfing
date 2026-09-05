import { SchedulingError, assertSchedule, type SchedulePrecision } from "../../src/domain/scheduling";

const monthNames = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

const weekdayNames = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"
];

const addDays = (localDate: string, days: number): string => {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
};

const nextWeekday = (today: string, weekday: number): string => {
  const [year, month, day] = today.split("-").map(Number);
  const current = new Date(Date.UTC(year, month - 1, day));
  let distance = (weekday - current.getUTCDay() + 7) % 7;
  if (distance === 0) distance = 7;
  return addDays(today, distance);
};

export interface ParsedCapture {
  title: string;
  schedulePrecision: SchedulePrecision;
  scheduledFor: string;
  scheduledTime?: string;
  estimatedMinutes?: number;
  tags?: string[];
  defaultedToToday: boolean;
}

export const parseTelegramCapture = (text: string, today: string): ParsedCapture => {
  let title = text.trim();
  let schedulePrecision: SchedulePrecision = "day";
  let scheduledFor = today;
  let scheduledTime: string | undefined;
  let estimatedMinutes: number | undefined;
  let tags: string[] | undefined;
  let defaultedToToday = true;

  const tagsMatch = title.match(/(?:\s+#[A-Za-z0-9_-]{1,64})+$/);
  if (tagsMatch) {
    const values = tagsMatch[0].match(/#[A-Za-z0-9_-]{1,64}/g) ?? [];
    tags = [...new Set(values.map(value => value.slice(1)))];
    if (tags.length > 20) {
      throw new SchedulingError("invalid_title", "Use no more than 20 task tags.");
    }
    title = title.slice(0, tagsMatch.index).trim();
  }

  const durationMatch = title.match(/(?:\s+\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b)+$/i);
  if (durationMatch) {
    const tokens: string[] = Array.from(
      durationMatch[0].match(/\d+\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b/gi) ?? []
    );
    estimatedMinutes = tokens.reduce<number>((total, token) => {
      const quantity = Number(token.match(/\d+/)?.[0] ?? 0);
      return total + (/h/i.test(token) ? quantity * 60 : quantity);
    }, 0);
    if (estimatedMinutes < 1 || estimatedMinutes > 1_440) {
      throw new SchedulingError("invalid_title", "Duration must be between 1 minute and 24 hours.");
    }
    title = title.slice(0, durationMatch.index).trim();
  }

  const timeMatch = title.match(/(?:\s+at)?\s+([01]\d|2[0-3]):([0-5]\d)$/i);
  if (timeMatch) {
    scheduledTime = `${timeMatch[1]}:${timeMatch[2]}`;
    title = title.slice(0, timeMatch.index).trim();
  }

  const explicitDay = title.match(/(?:\s+|^)(\d{4}-\d{2}-\d{2})$/);
  if (explicitDay) {
    scheduledFor = explicitDay[1];
    title = title.slice(0, explicitDay.index).trim();
    defaultedToToday = false;
  } else if (/\s+today$/i.test(title)) {
    title = title.replace(/\s+today$/i, "").trim();
    defaultedToToday = false;
  } else if (/\s+tomorrow$/i.test(title)) {
    scheduledFor = addDays(today, 1);
    title = title.replace(/\s+tomorrow$/i, "").trim();
    defaultedToToday = false;
  } else {
    const weekday = title.match(/\s+(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i);
    if (weekday) {
      scheduledFor = nextWeekday(today, weekdayNames.indexOf(weekday[1].toLowerCase()));
      title = title.slice(0, weekday.index).trim();
      defaultedToToday = false;
    } else {
      // Requiring "in" avoids treating verbs such as "may" as dates.
      const month = title.match(/\s+in\s+([a-z]+)(?:\s+(\d{4}))?$/i);
      if (month) {
        const monthIndex = monthNames.indexOf(month[1].toLowerCase());
        if (monthIndex >= 0) {
          const currentYear = Number(today.slice(0, 4));
          let year = month[2] ? Number(month[2]) : currentYear;
          const candidate = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
          if (!month[2] && candidate <= today.slice(0, 7)) year += 1;
          schedulePrecision = "month";
          scheduledFor = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
          title = title.slice(0, month.index).trim();
          defaultedToToday = false;
        }
      }
    }
  }

  if (!title) throw new SchedulingError("invalid_title", "Send an actionable task title.");
  if (title.length > 240) throw new SchedulingError("invalid_title", "Task titles must be 240 characters or fewer.");
  assertSchedule(schedulePrecision, scheduledFor, today, scheduledTime);
  return {
    title,
    schedulePrecision,
    scheduledFor,
    ...(scheduledTime ? { scheduledTime } : {}),
    ...(estimatedMinutes ? { estimatedMinutes } : {}),
    ...(tags?.length ? { tags } : {}),
    defaultedToToday
  };
};
