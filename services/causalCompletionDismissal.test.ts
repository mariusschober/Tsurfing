import { fenceLegacyBusinessStores, causalBusinessTransactionStores, readCausalBusiness } from './causalBusinessStorage';
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it } from 'vitest';
import { admitLocalCompletion, prepareCompletionRequest, commitCompletionReceipt, dismissRejectedCompletion,
  validateCompletionEvidence, type CompletionIntent } from './causalCompletionCoordinator';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { bindCausalCapability } from './causalEnrollment';
import { applyRemotePage, emptySyncMeta } from './syncProtocol';
import { STORES } from './storage';

const stores = ['tasks', 'stats', 'progress', 'goals', 'habits', 'task_events', 'tracking', 'sync'];
async function fixture() {
  const name = `s2-completion-dismissal-${crypto.randomUUID()}`, accountId = crypto.randomUUID(), sessionId = crypto.randomUUID(), epoch = crypto.randomUUID();
  const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3,
    focusSession: { schemaVersion: 1, sessionId, taskId: 'task', phase: 'active', plannedDurationSeconds: 600,
      startedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', elapsedSeconds: 0, pausedAt: null, endedAt: null } };
  await db.put('tracking', tracking, accountId);
  await db.put('tasks', [{ id: 'task', title: 'Synthetic completion', completed: false, dateAssigned: '2026-09-08' }], accountId);
  await db.put('stats', {}, accountId);
  await db.put('progress', { level: 1, xp: 0, xpToNextLevel: 100 }, accountId);
  await db.put('task_events', [], accountId);
  await db.put('sync', { ...emptySyncMeta(), cursor: 7 }, accountId); db.close();
  (await fenceLegacyTracking(name)).close();
  (await fenceLegacyBusinessStores(name)).close();
  await bindCausalCapability(name, accountId, { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision: 0, rolloutReady: false });
  const intent = (): CompletionIntent => ({ focus: { schemaVersion: 1, accountId, actionId: crypto.randomUUID(), actorId: 'tab', kind: 'complete',
    sessionId, taskId: 'task', epoch: sessionId, expectedCurrentSessionId: sessionId, capturedAt: '2026-09-08T00:05:00.000Z', durationSeconds: null },
  details: { day: '2026-09-08', timeZone: 'Atlantic/Canary' }, deviceId: 'tab' });
  const read = async () => {
    const db = await openDB(name), values: any = {};
    for (const store of [...stores, CAUSAL_STORE]) {
      const tx = db.transaction(causalBusinessTransactionStores(db, [store]));
      values[store] = store === 'tracking' || store === CAUSAL_STORE ? await tx.objectStore(store).get(accountId) : await readCausalBusiness(tx, store, accountId);
      await tx.done;
    }
    db.close(); return values;
  };
  const receipt = (bytes: string, trackingValue: any) => {
    const operation = JSON.parse(bytes);
    return { schemaVersion: 2, epoch, projectionRevision: 1, operation, accepted: true,
      outcome: { accepted: true, code: 'APPLIED', revision: operation.command.actionId },
      record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', payload: trackingValue, version: 2, server_version: 100,
        device_id: 'causal-completion-v2', updated_at: operation.command.capturedAt, deleted_at: null },
      changes: operation.changes.map((member: any, index: number) => ({ mutationId: member.mutationId, accepted: true, serverVersion: 80 + index,
        record: { user_id: accountId, entity_type: member.entityType, entity_id: member.entityId, payload: member.payload, version: member.version,
          server_version: 80 + index, device_id: member.deviceId, updated_at: member.updatedAt, deleted_at: null } })) };
  };
  return { name, accountId, sessionId, intent, read, receipt };
}
const rejected = (receipt: any, sessionId: string) => ({ ...receipt, accepted: false,
  outcome: { accepted: false, code: 'STALE_REVISION', revision: sessionId }, changes: [] });

it('dismisses a rejected completion, releases reservations and retains audit evidence', async () => {
  const f = await fixture(), intent = f.intent();
  await admitLocalCompletion(f.name, intent);
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId);
  const values = await f.read();
  await commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, rejected(f.receipt(bytes, values[CAUSAL_STORE].trackingValue), f.sessionId));
  const pending = await f.read();
  expect(Object.keys(pending.sync.localState.completionReservations)).toHaveLength(4);
  const paused = () => applyRemotePage(pending.sync, { tasks: pending.tasks },
    [{ entityType: 'tasks', entityId: 'task', version: 2, serverVersion: 10, payload: pending.tasks[0] }], 10, 'remote', intent.focus.capturedAt);
  expect(paused).toThrow('atomic completion');
  const result = await dismissRejectedCompletion(f.name, f.accountId, intent.focus.actionId, 'superseded by a newer plan');
  expect(result).toEqual({ dismissed: true, actionId: intent.focus.actionId });
  const after = await f.read();
  expect(after[CAUSAL_STORE].completionOutbox[intent.focus.actionId]).toBeUndefined();
  expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(0);
  expect(after[CAUSAL_STORE].completionAdmissions[intent.focus.actionId]).toBeDefined();
  expect(after[CAUSAL_STORE].completionReceipts[intent.focus.actionId].accepted).toBe(false);
  expect(after[CAUSAL_STORE].completionDismissals[intent.focus.actionId]).toMatchObject({ reason: 'superseded by a newer plan' });
  expect(after.tasks[0]).toMatchObject({ completed: true });
  validateCompletionEvidence(f.accountId, after[CAUSAL_STORE], after.sync);
  expect(() => applyRemotePage(after.sync, { tasks: after.tasks },
    [{ entityType: 'tasks', entityId: 'task', version: 2, serverVersion: 10, payload: after.tasks[0] }], 10, 'remote', intent.focus.capturedAt)).not.toThrow();
});

it('refuses unknown, pending and accepted dismissals without changing state', async () => {
  const f = await fixture(), intent = f.intent();
  await expect(dismissRejectedCompletion(f.name, f.accountId, intent.focus.actionId, 'reason')).rejects.toThrow('unknown');
  await expect(dismissRejectedCompletion(f.name, f.accountId, intent.focus.actionId, '  ')).rejects.toThrow('short reason');
  await admitLocalCompletion(f.name, intent);
  const pending = await f.read();
  await expect(dismissRejectedCompletion(f.name, f.accountId, intent.focus.actionId, 'reason')).rejects.toThrow('Only a rejected completion');
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId);
  const values = await f.read();
  await commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, f.receipt(bytes, values[CAUSAL_STORE].trackingValue));
  // An accepted completion retires its pending intent: nothing to dismiss.
  await expect(dismissRejectedCompletion(f.name, f.accountId, intent.focus.actionId, 'reason')).rejects.toThrow('not pending');
  const after = await f.read();
  expect(Object.keys(after.sync.localState.completionReservations)).toHaveLength(0);
  expect(after[CAUSAL_STORE].completionOutbox[intent.focus.actionId]).toBeUndefined();
  expect(after[CAUSAL_STORE].completionDismissals).toBeUndefined();
  expect(pending[CAUSAL_STORE].completionAdmissions).toEqual(after[CAUSAL_STORE].completionAdmissions);
});

it('refuses any reuse of a dismissed identity', async () => {
  const f = await fixture(), intent = f.intent();
  await admitLocalCompletion(f.name, intent);
  const bytes = await prepareCompletionRequest(f.name, f.accountId, intent.focus.actionId);
  const values = await f.read();
  await commitCompletionReceipt(f.name, f.accountId, intent.focus.actionId, rejected(f.receipt(bytes, values[CAUSAL_STORE].trackingValue), f.sessionId));
  await dismissRejectedCompletion(f.name, f.accountId, intent.focus.actionId, 'first');
  const id = intent.focus.actionId;
  await expect(dismissRejectedCompletion(f.name, f.accountId, id, 'second')).rejects.toThrow('not pending');
  await expect(prepareCompletionRequest(f.name, f.accountId, id)).rejects.toThrow('dismissed');
  await expect(commitCompletionReceipt(f.name, f.accountId, id, f.receipt(bytes, values[CAUSAL_STORE].trackingValue))).rejects.toThrow('dismissed');
  await expect(admitLocalCompletion(f.name, intent)).rejects.toThrow('dismissed');
});
