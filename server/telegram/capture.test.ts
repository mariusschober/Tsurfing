import { describe, expect, it } from 'vitest';
import { SchedulingError } from '../../src/domain/scheduling';
import { parseTelegramCapture } from './capture';

describe('Telegram quick capture', () => {
  it('defaults undated text to today and marks the default', () => {
    expect(parseTelegramCapture('Write launch notes', '2026-07-18')).toEqual({
      title: 'Write launch notes', schedulePrecision: 'day', scheduledFor: '2026-07-18', defaultedToToday: true
    });
  });

  it('parses tomorrow using calendar arithmetic', () => {
    expect(parseTelegramCapture('Renew certificate tomorrow', '2026-12-31').scheduledFor).toBe('2027-01-01');
  });

  it('parses an explicit local day', () => {
    expect(parseTelegramCapture('Call Alex 2026-08-02', '2026-07-18')).toMatchObject({ title: 'Call Alex', schedulePrecision: 'day', scheduledFor: '2026-08-02' });
  });

  it('moves an implicit past month into the next year', () => {
    expect(parseTelegramCapture('Review insurance in June', '2026-07-18')).toMatchObject({ title: 'Review insurance', schedulePrecision: 'month', scheduledFor: '2027-06' });
  });

  it('rejects a current explicit month and an empty title', () => {
    expect(() => parseTelegramCapture('Review insurance in July 2026', '2026-07-18')).toThrow(SchedulingError);
    expect(() => parseTelegramCapture('2026-08-02', '2026-07-18')).toThrow('actionable task title');
  });

  it('parses explicit today and the next occurrence of a weekday', () => {
    expect(parseTelegramCapture('Send report today', '2026-09-04')).toMatchObject({
      title: 'Send report', scheduledFor: '2026-09-04', defaultedToToday: false
    });
    expect(parseTelegramCapture('Send report Friday', '2026-09-04')).toMatchObject({
      title: 'Send report', scheduledFor: '2026-09-11', defaultedToToday: false
    });
  });

  it('parses time, duration and deduplicated tags without changing the date default', () => {
    expect(parseTelegramCapture('Call Peter tomorrow at 14:30 1h 30m #sales #sales', '2026-08-30')).toMatchObject({
      title: 'Call Peter',
      scheduledFor: '2026-08-31',
      scheduledTime: '14:30',
      estimatedMinutes: 90,
      tags: ['sales'],
      defaultedToToday: false
    });
    expect(parseTelegramCapture('Draft proposal 45m #work', '2026-08-30')).toMatchObject({
      title: 'Draft proposal', estimatedMinutes: 45, tags: ['work'], defaultedToToday: true
    });
  });

  it('rejects ambiguous or invalid rich scheduling input instead of coercing it', () => {
    expect(parseTelegramCapture('We may review', '2026-08-30')).toMatchObject({ title: 'We may review' });
    expect(() => parseTelegramCapture('Review in September at 14:30', '2026-08-30')).toThrow(SchedulingError);
    expect(() => parseTelegramCapture(`Task ${'x'.repeat(241)}`, '2026-08-30')).toThrow(/240/);
    expect(() => parseTelegramCapture('Task 25h', '2026-08-30')).toThrow(/24 hours/);
  });
});
