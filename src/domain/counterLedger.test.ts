import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectCounters, type CounterBaseline, type CounterDelta } from './counterLedger';

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/s2/counters-v1.json', import.meta.url), 'utf8'));

describe('shared S2 counter equation', () => {
  for (const scenario of fixture.cases) it(scenario.name, () => {
    const before = JSON.stringify(fixture);
    if (scenario.error) {
      expect(() => projectCounters(fixture.baseline, scenario.events)).toThrow(expect.objectContaining({ code: scenario.error }));
    } else {
      expect(projectCounters(fixture.baseline, scenario.events)).toEqual(scenario.expected);
      expect(projectCounters(fixture.baseline, [...scenario.events].reverse())).toEqual(scenario.expected);
    }
    expect(JSON.stringify(fixture)).toBe(before);
  });

  it('does not use focus timestamps or modify the tracking envelope', () => {
    const tracking = { focusSession: { sessionId: 'newer-F1', updatedAt: '2099-01-01T00:00:00Z' }, future: { retained: true } };
    expect({ ...tracking, ...projectCounters(fixture.baseline, fixture.cases[1].events) }).toEqual({
      ...tracking, planViewCount: 28, dailyPostponeCount: 4
    });
  });

  it('sums corrections exactly before checking the final supported range', () => {
    const baseline: CounterBaseline = { ...fixture.baseline, counts: { planViewCount: 0, dailyPostponeCount: 3 } };
    const first: CounterDelta = { ...fixture.cases[1].events[0], delta: -1, correctionOf: fixture.baseline.evidenceIds[0] };
    const second: CounterDelta = { ...first, actionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', delta: 1 };
    expect(projectCounters(baseline, [first, second])).toEqual(baseline.counts);
    expect(() => projectCounters(baseline, [first])).toThrow(expect.objectContaining({ code: 'RANGE' }));
  });
});
