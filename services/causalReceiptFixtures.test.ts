import { describe, expect, it } from 'vitest';
import fixture from '../tests/fixtures/s2/action-receipts-v2.json';
import { assertCausalReceipt, parseCausalOperation } from './causalProtocol';
import { assertCausalCompletionReceipt, parseCausalCompletion } from './causalCompletionProtocol';
import { assertCausalHistoryEntry } from './causalHistoryProtocol';

describe('shared native action receipt fixtures', () => {
  it('validates the shared cutover baseline', () => {
    expect(assertCausalHistoryEntry(fixture.accountId, fixture.cutover.epoch, 0, fixture.cutover)).toBe(fixture.cutover);
  });
  it.each(fixture.cases)('validates $name without rewriting receipt evidence', ({ operation, receipt }) => {
    const check = (value: unknown) => operation.type === 'completion'
      ? assertCausalCompletionReceipt(fixture.accountId, parseCausalCompletion(fixture.accountId, operation), value)
      : assertCausalReceipt(fixture.accountId, parseCausalOperation(fixture.accountId, operation), value);
    expect(check(receipt)).toBe(receipt);
    expect(assertCausalHistoryEntry(fixture.accountId, operation.epoch, 1,
      { schemaVersion: 2, accountId: fixture.accountId, epoch: operation.epoch, revision: 1, receipt }).receipt).toBe(receipt);
    for (const damage of [
      (r: any) => { r.projectionRevision = 0; },
      (r: any) => { r.operation.command.actorId = 'changed'; },
      (r: any) => { r.record.user_id = '22222222-2222-4222-8222-222222222222'; },
      (r: any) => { delete r.record.deleted_at; },
    ]) {
      const altered = structuredClone(receipt);
      damage(altered);
      expect(() => check(altered)).toThrow();
    }
  });
});
