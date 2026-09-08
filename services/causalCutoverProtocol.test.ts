import { expect, it } from 'vitest';
import { assertCausalCutoverReceipt, parseCausalCutover } from './causalCutoverProtocol';

const accountId = '11111111-1111-4111-8111-111111111111';
const cutoverId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const payload = JSON.parse('{"date":"2026-09-08","planViewCount":27,"dailyPostponeCount":3,"future":{"retained":true},"__proto__":{"evidence":true}}');
  const operation = parseCausalCutover(accountId, { schemaVersion: 2, accountId, cutoverId,
    expectedTrackingServerVersion: 7, expectedTrackingPayload: payload });
  const receipt = { schemaVersion: 2, operation: structuredClone(operation), epoch: cutoverId, projectionRevision: 0,
    baseline: { schemaVersion: 1, baselineId: cutoverId, accountId, day: payload.date,
      counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [cutoverId] },
    record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 7,
      device_id: 'test', updated_at: '2026-09-08T10:00:00.123456+00:00', deleted_at: null, payload: structuredClone(payload) } };
  return { operation, receipt };
}

it('preserves exact payload evidence and accepts the same cutover receipt on replay', () => {
  const { operation, receipt } = fixture();
  expect(Object.hasOwn(operation.expectedTrackingPayload, '__proto__')).toBe(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(assertCausalCutoverReceipt(accountId, operation, receipt)).toBe(receipt);
  }
});

it('rejects a self-consistent receipt for a different attempted snapshot', () => {
  const { operation, receipt } = fixture();
  receipt.record.payload.future.retained = false;
  receipt.operation.expectedTrackingPayload = structuredClone(receipt.record.payload);
  expect(() => assertCausalCutoverReceipt(accountId, operation, receipt)).toThrow('exact attempted cutover');
});

it.each(['account', 'version', 'baseline', 'epoch', 'revision', 'deleted'])('rejects mismatched %s evidence', field => {
  const { operation, receipt } = fixture();
  if (field === 'account') receipt.record.user_id = cutoverId;
  if (field === 'version') receipt.record.server_version++;
  if (field === 'baseline') receipt.baseline.counts.planViewCount++;
  if (field === 'epoch') receipt.epoch = accountId;
  if (field === 'revision') receipt.projectionRevision++;
  if (field === 'deleted') Object.assign(receipt.record, { deleted_at: receipt.record.updated_at });
  expect(() => assertCausalCutoverReceipt(accountId, operation, receipt)).toThrow();
});

it('refuses absent tracking, fabricated creation versions, unknown envelope fields and cross-account enrollment', () => {
  const { operation } = fixture();
  for (const change of [{ expectedTrackingPayload: null }, { expectedTrackingPayload: [] },
    { expectedTrackingServerVersion: 0 }, { expectedTrackingServerVersion: Number.MAX_SAFE_INTEGER + 1 },
    { accountId: cutoverId }, { force: true }]) {
    expect(() => parseCausalCutover(accountId, { ...operation, ...change })).toThrow();
  }
  for (const field of [{ planViewCount: -1 }, { dailyPostponeCount: '3' }, { date: '2026-02-30' },
    { focusSession: { phase: 'active' } }]) {
    expect(() => parseCausalCutover(accountId, { ...operation,
      expectedTrackingPayload: { ...operation.expectedTrackingPayload, ...field } })).toThrow('Invalid cutover baseline');
  }
});
