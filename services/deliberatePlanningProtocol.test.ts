import { expect, it } from 'vitest';
import { assertPlanningReview } from './deliberatePlanningProtocol';
import { type ConfirmOrder, initialPlanningPolicy } from '../src/domain/deliberatePlanning';
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const command: ConfirmOrder = { schemaVersion: 1, operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accountId,
  localDate: '2026-09-08', baselineRevision: null, proposedOrder: ['moved', 'deleted', 'missing'], ratings: [],
  maximumAcceptedXp: 0, capturedAt: '2026-09-08T18:00:00.000Z' };
function fixture() {
  const receipt = { command, code: 'STALE_REVISION' as const, revision: null, acceptedReplans: 0,
    actualDebit: 0, requiredCost: 0, order: [] };
  const policy = { ...initialPlanningPolicy(accountId, command.localDate), history: [receipt] };
  const row = (id: string, deleted: boolean) => ({ user_id: accountId, entity_type: 'tasks', entity_id: id,
    version: 1, server_version: 2, device_id: 'other-device', updated_at: command.capturedAt,
    deleted_at: deleted ? command.capturedAt : null,
    payload: { id, scheduledFor: '2026-09-09', completed: deleted } });
  return { schemaVersion: 1, accountId, operationId: command.operationId,
    response: { schemaVersion: 1, accountId, receipt, policy, records: [] }, policy,
    records: [row('moved', false), row('deleted', true)], missingTaskIds: ['missing'] };
}
it('accounts for moved tasks, tombstones and explicit missing task evidence', () => {
  expect(assertPlanningReview(accountId, command, fixture()).records).toHaveLength(2);
});
it('rejects omitted tasks, contradictory absence, unrelated records and cross-account evidence', () => {
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => { value.records.pop(); },
    (value: ReturnType<typeof fixture>) => { value.missingTaskIds.push('moved'); },
    (value: ReturnType<typeof fixture>) => { value.records[0].entity_id = value.records[0].payload.id = 'unrelated'; },
    (value: ReturnType<typeof fixture>) => { value.records[0].user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; },
    (value: ReturnType<typeof fixture>) => { value.policy = { ...value.policy, history: [] }; },
  ]) {
    const value = fixture(); mutate(value);
    expect(() => assertPlanningReview(accountId, command, value)).toThrow();
  }
});
