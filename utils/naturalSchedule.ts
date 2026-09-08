import { getTodayYYYYMMDD } from './dateUtils';

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pattern = new RegExp(`(?<![\\w/#@-])(?:in\\s+([1-9]\\d{0,3})\\s+(days?|weeks?|months?)|next\\s+(week|month)|today|tomorrow|(?:next\\s+)?(?:${weekdays.join('|')})|(?:in\\s+)?(?:${months.join('|')})(?:\\s+\\d{4})?)(?![\\w/-])`, 'gi');

export interface NaturalSchedule {
  cleanTitle: string;
  scheduledFor?: string;
  schedulePrecision?: 'day' | 'month';
}

// Calendar arithmetic uses an explicit local-day string, independent of DST and server timezone.
export function parseNaturalSchedule(title: string, today = getTodayYYYYMMDD()): NaturalSchedule {
  const [year, month, day] = today.split('-').map(Number);
  for (const match of title.matchAll(pattern)) {
    const token = match[0].toLowerCase().replace(/\s+/g, ' ');
    let date = new Date(Date.UTC(year, month - 1, day));
    let precision: 'day' | 'month' = 'day';
    if (match[1]) {
      const count = Number(match[1]);
      if (match[2].toLowerCase().startsWith('month')) {
        date = new Date(Date.UTC(year, month - 1 + count, 1));
        precision = 'month';
      } else date.setUTCDate(day + count * (match[2].toLowerCase().startsWith('week') ? 7 : 1));
    } else if (token === 'next month') {
      date = new Date(Date.UTC(year, month, 1));
      precision = 'month';
    } else if (token === 'next week') date.setUTCDate(day + 7);
    else if (token === 'tomorrow') date.setUTCDate(day + 1);
    else if (token !== 'today') {
      const weekday = weekdays.indexOf(token.replace(/^next /, ''));
      if (weekday >= 0) date.setUTCDate(day + ((weekday - date.getUTCDay() + 7) % 7 || 7));
      else {
        // Keep ordinary verbs ("we may", "march forward") as title text.
        if ((token === 'may' || token === 'march') && match[0] === token) continue;
        const parts = token.replace(/^in /, '').split(' ');
        const monthIndex = months.indexOf(parts[0]);
        let targetYear = parts[1] ? Number(parts[1]) : year;
        if (!parts[1] && monthIndex + 1 <= month) targetYear++;
        date = new Date(Date.UTC(targetYear, monthIndex, 1));
        precision = 'month';
      }
    }
    const scheduledFor = date.toISOString().slice(0, precision === 'month' ? 7 : 10);
    return { cleanTitle: (title.slice(0, match.index) + title.slice(match.index! + match[0].length)).replace(/\s+/g, ' ').trim(), scheduledFor, schedulePrecision: precision };
  }
  return { cleanTitle: title };
}
