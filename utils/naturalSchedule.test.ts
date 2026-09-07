import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseNaturalSchedule } from './naturalSchedule';
import { parseTitleForExtras } from './timeAndTagParser';
const cases = [["2026-09-07", "Send report today", "2026-09-07", "day", "Send report"], ["2026-12-31", "Send report tomorrow", "2027-01-01", "day", "Send report"], ["2026-09-07", "Send report next week", "2026-09-14", "day", "Send report"], ["2026-12-31", "Send report next month", "2027-01", "month", "Send report"], ["2026-08-31", "Send report September", "2026-09", "month", "Send report"], ["2026-09-07", "Send report September", "2027-09", "month", "Send report"], ["2026-12-20", "Send report in 3 weeks", "2027-01-10", "day", "Send report"], ["2028-02-26", "Send report in 4 days", "2028-03-01", "day", "Send report"], ["2026-01-31", "Send report in 3 months", "2026-04", "month", "Send report"], ["2026-09-07", "Tomorrow send report", "2026-09-08", "day", "send report"], ["2026-09-07", "Send report Friday", "2026-09-11", "day", "Send report"], ["2026-09-07", "Send report in May", "2027-05", "month", "Send report"]] as const;
describe('natural capture scheduling', () => {
  afterEach(() => vi.useRealTimers());
  it.each(cases)('%s: %s', (today, title, scheduledFor, schedulePrecision, cleanTitle) => {
    expect(parseNaturalSchedule(title, today)).toEqual({ cleanTitle, scheduledFor, schedulePrecision });
  });
  it.each(['We may review', 'march forward', 'Review months of notes', 'Review in 0 days', 'Visit https://example.com/today', 'Review #September'])('preserves ordinary text: %s', title => {
    expect(parseNaturalSchedule(title, '2026-09-07')).toEqual({ cleanTitle: title });
  });
  it('keeps month precision through the existing web capture parser', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 7, 12));
    expect(parseTitleForExtras('Review next month @25m #work')).toMatchObject({cleanTitle:'Review', duration:25, hashtags:['work'], scheduledFor:'2026-10', schedulePrecision:'month', dateAssigned:'2026-10-01'});
  });
});
