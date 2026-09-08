
import { parseNaturalSchedule } from './naturalSchedule';
import { Session } from '../types';
import { getTodayYYYYMMDD, getTomorrowYYYYMMDD, getNextDayOfWeek, toYYYYMMDD } from './dateUtils';

interface ParsedData {
  cleanTitle: string;
  duration: number | undefined;
  hashtags: string[];
  dateAssigned: string | undefined;
  scheduledFor?: string;
  schedulePrecision?: 'day' | 'month';
  session: Session | undefined;
  isFrog?: boolean;
  isQuickie?: boolean;
}

export const parseTitleForExtras = (title: string): ParsedData => {
  let cleanTitle = title;
  let duration: number | undefined = undefined;
  let dateAssigned: string | undefined = undefined;
  let session: Session | undefined = undefined;
  let isFrog = false;
  let isQuickie = false;

  // 1. Frog Detection: *f or *frog
  const frogRegex = /\*f(rog)?\b/i;
  if (frogRegex.test(cleanTitle)) {
      isFrog = true;
      cleanTitle = cleanTitle.replace(frogRegex, '');
  }

  // 2. Quickie Detection: @quick or @quickie (implies 2 minutes)
  const quickieRegex = /@quick(ie)?\b/i;
  if (quickieRegex.test(cleanTitle)) {
      isQuickie = true;
      duration = 2; // Quickies are < 2 mins, we set 2 as placeholder
      cleanTitle = cleanTitle.replace(quickieRegex, '');
  }

  // 3. Parse Time Estimates: @21m, @30min, @4h
  const shortTimeRegex = /@(\d+)(m|min|mins|h|hr|hrs)\b/gi;
  cleanTitle = cleanTitle.replace(shortTimeRegex, (match, value, unit) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      if (unit.toLowerCase().startsWith('h')) {
        duration = (duration || 0) + num * 60;
      } else {
        duration = (duration || 0) + num;
        if (duration <= 2 && !isQuickie) {
             isQuickie = true;
        }
      }
    }
    return ''; 
  });

  // 4. Natural Language Duration
  const naturalDurationRegex = /\b(?:for )?(\d+)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/gi;
  cleanTitle = cleanTitle.replace(naturalDurationRegex, (match, value, unit) => {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
          if (unit.toLowerCase().startsWith('h')) {
              duration = (duration || 0) + num * 60;
          } else {
              duration = (duration || 0) + num;
              if ((duration || 0) <= 2 && !isQuickie) isQuickie = true;
          }
      }
      return '';
  });

  // 3b. Adjective Duration
  const adjectiveDurationRegex = /\b(\d+)-(?:minute|min|hour|hr)\b/gi;
  cleanTitle = cleanTitle.replace(adjectiveDurationRegex, (match, value) => {
      const num = parseInt(value, 10);
      if (!isNaN(num)) {
          if (match.toLowerCase().includes('h')) {
               duration = (duration || 0) + num * 60;
          } else {
               duration = (duration || 0) + num;
               if ((duration || 0) <= 2 && !isQuickie) isQuickie = true;
          }
      }
      return '';
  });

  // 5. Parse Hashtags
  const hashtagRegex = /#([a-zA-Z0-9_]+)\b/g;
  const hashtags: string[] = [];
  cleanTitle = cleanTitle.replace(hashtagRegex, (match, tag) => {
    hashtags.push(tag);
    return ''; 
  });

  // 6. Specific Time Parsing
  const timeAtRegex = /\bat (\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  cleanTitle = cleanTitle.replace(timeAtRegex, (match, hourStr, minStr, meridiem) => {
      let hour = parseInt(hourStr, 10);
      const isPm = meridiem.toLowerCase() === 'pm';
      
      if (isPm && hour < 12) hour += 12;
      if (!isPm && hour === 12) hour = 0;

      if (hour >= 4 && hour < 12) session = 'morning';
      else if (hour >= 12 && hour < 17) session = 'afternoon';
      else session = 'evening';

      return '';
  });

  // 7. Date & Session Keywords
  const lowerTitle = cleanTitle.toLowerCase();
  
  if (!session) {
    if (/\b(morning|morn)\b/i.test(lowerTitle)) {
        session = 'morning';
        cleanTitle = cleanTitle.replace(/\b(in the )?(morning|morn)\b/i, '');
    } else if (/\b(afternoon|noon)\b/i.test(lowerTitle)) {
        session = 'afternoon';
        cleanTitle = cleanTitle.replace(/\b(in the )?(afternoon|noon)\b/i, '');
    } else if (/\b(evening|eve|night|tonight)\b/i.test(lowerTitle)) {
        session = 'evening';
        cleanTitle = cleanTitle.replace(/\b(in the )?(evening|eve|night)\b/i, '');
        
        if (lowerTitle.includes('tonight') && !dateAssigned) {
            dateAssigned = getTodayYYYYMMDD();
            cleanTitle = cleanTitle.replace(/\btonight\b/i, '');
        }
    }
  }

  const natural = parseNaturalSchedule(cleanTitle);
  if (natural.scheduledFor) {
      dateAssigned = natural.schedulePrecision === 'month' ? `${natural.scheduledFor}-01` : natural.scheduledFor;
      cleanTitle = natural.cleanTitle;
  } else if (/\b(today|tod)\b/i.test(lowerTitle)) {
      dateAssigned = getTodayYYYYMMDD();
      cleanTitle = cleanTitle.replace(/\b(today|tod)\b/i, '');
  } else if (/\b(tomorrow|tmrw|tom)\b/i.test(lowerTitle)) {
      dateAssigned = getTomorrowYYYYMMDD();
      cleanTitle = cleanTitle.replace(/\b(tomorrow|tmrw|tom)\b/i, '');
  } else if (/\bnext week\b/i.test(lowerTitle)) {
      const d = new Date();
      d.setDate(d.getDate() + 7);
      dateAssigned = toYYYYMMDD(d);
      cleanTitle = cleanTitle.replace(/\bnext week\b/i, '');
  } else {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const shortDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      
      for (let i = 0; i < 7; i++) {
          const regex = new RegExp(`\\b(next )?(${days[i]}|${shortDays[i]})\\b`, 'i');
          if (regex.test(lowerTitle)) {
              dateAssigned = getNextDayOfWeek(i);
              cleanTitle = cleanTitle.replace(regex, '');
              break;
          }
      }
  }

  cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim();

  return { cleanTitle, duration, hashtags, dateAssigned, scheduledFor: natural.scheduledFor, schedulePrecision: natural.schedulePrecision, session, isFrog, isQuickie };
};

export const formatDuration = (minutes: number): string => {
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
        return `${hours}h`;
    }
    return `${hours}h ${remainingMinutes}m`;
};
