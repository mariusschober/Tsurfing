import { parseNaturalSchedule } from '../../utils/naturalSchedule';
import { SchedulingError, assertSchedule, type SchedulePrecision } from "../../src/domain/scheduling";

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
  } else {
    const natural = parseNaturalSchedule(title, today);
    if (natural.scheduledFor) {
      title = natural.cleanTitle;
      scheduledFor = natural.scheduledFor;
      schedulePrecision = natural.schedulePrecision!;
      defaultedToToday = false;
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
