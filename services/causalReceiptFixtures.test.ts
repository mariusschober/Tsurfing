import { describe, expect, it } from 'vitest';
import fixture from '../tests/fixtures/s2/action-receipts-v2.json';
import { assertCausalReceipt, parseCausalOperation } from './causalProtocol';

describe('shared native action receipt fixtures', () => {
  it.each(fixture.cases)('validates $name without rewriting receipt evidence', ({ operation, receipt }) => {
    const parsed = parseCausalOperation(fixture.accountId, operation);
    expect(assertCausalReceipt(fixture.accountId, parsed, receipt)).toBe(receipt);
    for (const damage of [
      (r: any) => { r.projectionRevision = 0; },
      (r: any) => { r.operation.command.actorId = 'changed'; },
      (r: any) => { r.record.user_id = '22222222-2222-4222-8222-222222222222'; },
      (r: any) => { delete r.record.deleted_at; },
    ]) {
      const altered = structuredClone(receipt);
      damage(altered);
      expect(() => assertCausalReceipt(fixture.accountId, parsed, altered)).toThrow();
    }
  });
});
