import { describe, expect, it } from 'vitest';
import fixture from '../tests/fixtures/s2/history-replay-v2.json';
import { replayCausalHistory } from './causalProjection';
import { validateSavedCausalHistory, type SavedCausalHistory } from './causalHistory';
import { causalHistoryHash } from './causalHistoryProtocol';

describe('shared complete native replay history', () => {
  it('rejects reuse of the cutover identity for a new day baseline', async () => {
    const history = fixture.reusedBaselineHistory as SavedCausalHistory;
    await validateSavedCausalHistory(fixture.accountId, history);
    expect(() => replayCausalHistory(fixture.accountId, history)).toThrow(/immutable identity/);
  });
  it('reconstructs counters, focus, completion and day selection', async () => {
    const history = fixture.history as SavedCausalHistory;
    await validateSavedCausalHistory(fixture.accountId, history);
    const result = replayCausalHistory(fixture.accountId, history);
    expect(result.tracking.planViewCount).toBe(28);
    expect(result.tracking.dailyPostponeCount).toBe(3);
    expect(result.tracking.focusSession.phase).toBe('completed');
    expect(Object.keys(result.receipts)).toHaveLength(4);
  });
  it('rejects a validly hashed receipt that invents an extra increment', async () => {
    const history = structuredClone(fixture.history) as SavedCausalHistory;
    const entry = JSON.parse(history.entries['1'].body);
    entry.receipt.outcome.counts.planViewCount = 29;
    entry.receipt.record.payload.planViewCount = 29;
    history.entries['1'].body = JSON.stringify(entry);
    history.entries['1'].sha256 = await causalHistoryHash(new TextEncoder().encode(history.entries['1'].body));
    await validateSavedCausalHistory(fixture.accountId, history);
    expect(() => replayCausalHistory(fixture.accountId, history)).toThrow(/conservation/);
  });
});
