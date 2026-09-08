import { openDB } from 'idb';
import { v5 as uuidv5 } from 'uuid';
import type { Task } from '../types';
import { validateCounterDelta, type CounterDelta } from '../src/domain/counterLedger';
import { applyLocalCounter } from './causalCounterCoordinator';
import type { CounterDayAccountState } from './causalCounterDayCoordinator';
import { CAUSAL_STORE, TRACKING_KEY_PATH, readCausalAccount } from './causalStorage';
import { causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { assertCompletionCapturesMaterialized } from './causalCompletionCoordinator';
import { appendStagedTransactions, buildStagedLocalTransaction, normalizeSyncMeta, stableJson, type StagedLocalTransaction } from './syncProtocol';
import { assertNewSyncPayload } from './syncEnvelope';

export interface RescheduleIntent {
  schemaVersion: 1;
  actionId: string;
  accountId: string;
  actorId: string;
  deviceId: string;
  taskId: string;
  newDate: string;
  day: string;
  timeZone: string;
  capturedAt: string;
}
interface RescheduleAdmission {
  intent: RescheduleIntent;
  outcome: 'applied' | 'unavailable' | 'frog';
  becameFrog: boolean;
  transaction?: StagedLocalTransaction;
  counter?: CounterDelta;
}
export interface RescheduleAccountState extends CounterDayAccountState {
  rescheduleAdmissions?: Record<string, RescheduleAdmission>;
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const validDay = (day: string) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
  && Number.isFinite(Date.parse(day + 'T00:00:00.000Z')) && new Date(day + 'T00:00:00.000Z').toISOString().slice(0, 10) === day;

/** Capture only target/date intent outside the coordinator. The actual task,
 * reschedule count and day increment are derived under this single transaction.
 * Ordinary task transport retains its exact existing receipt contract. */
export async function admitLocalReschedule(name: string, captured: RescheduleIntent) {
  const intent = structuredClone(captured);
  // Reuse the canonical account/action/day/timestamp validation at admission.
  const counter: CounterDelta = { schemaVersion: 1, actionId: intent.actionId, accountId: intent.accountId,
    actorId: intent.actorId, day: intent.day, timeZone: intent.timeZone, capturedAt: intent.capturedAt,
    counter: 'dailyPostponeCount', delta: 1, businessActionId: intent.actionId, correctionOf: null };
  validateCounterDelta(counter);
  if (intent.schemaVersion !== 1 || !validDay(intent.newDate) || typeof intent.taskId !== 'string' || !intent.taskId
    || typeof intent.deviceId !== 'string' || !intent.deviceId || intent.deviceId.length > 240) throw new Error('Invalid reschedule intent.');
  counter.actionId = uuidv5('reschedule-counter-v1', intent.actionId);
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Rescheduling requires the prepared causal account.');
    const tx = db.transaction(causalBusinessTransactionStores(db, [CAUSAL_STORE, 'tracking', 'tasks', 'sync']), 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, intent.accountId) as RescheduleAccountState | undefined;
      if (!state || !state.trackingPresent) throw new Error('Rescheduling requires retained causal tracking.');
      const prior = state.rescheduleAdmissions?.[intent.actionId], identity = state.actionIdentities?.[intent.actionId];
      if (prior || identity) {
        if (!prior || !same(prior.intent, intent) || identity?.kind !== 'reschedule' || !same(identity.intent, intent)) {
          throw new Error('The reschedule action ID has different or incomplete intent.');
        }
        await tx.done;
        return { duplicate: true, generation: state.generation, admission: prior };
      }
      const rawMeta = await readCausalBusiness(tx, 'sync', intent.accountId);
      let meta = normalizeSyncMeta(rawMeta);
      assertCompletionCapturesMaterialized(intent.accountId, meta);
      const tasks = await readCausalBusiness(tx, 'tasks', intent.accountId) as Task[] | undefined;
      if (!Array.isArray(tasks) || tasks.some(t => !t || typeof t !== 'object' || typeof t.id !== 'string')
        || new Set(tasks.map(t => t.id)).size !== tasks.length) throw new Error('Task storage requires recovery before rescheduling.');
      const task = tasks.find(t => t.id === intent.taskId);
      const admission: RescheduleAdmission = { intent, outcome: !task || task.completed || task.wontDo || task.deletedAt
        ? 'unavailable' : task.isFrog ? 'frog' : 'applied', becameFrog: false };
      if (admission.outcome === 'applied' && task) {
        if (!validDay(task.dateAssigned) || (task.rescheduleCount !== undefined
          && (!Number.isSafeInteger(task.rescheduleCount) || task.rescheduleCount < 0))) throw new Error('The retained task schedule requires recovery.');
        const pushing = intent.newDate > task.dateAssigned;
        const count = (task.rescheduleCount ?? 0) + (pushing ? 1 : 0);
        if (!Number.isSafeInteger(count)) throw new Error('Task reschedule count exhausted.');
        admission.becameFrog = count >= 2;
        const next = { ...task, dateAssigned: intent.newDate, schedulePrecision: 'day' as const,
          scheduledFor: intent.newDate, plannedOrder: 0, session: undefined, rescheduleCount: count,
          frogFailures: count, isFrog: admission.becameFrog || task.isFrog };
        assertNewSyncPayload(next);
        const nextTasks = tasks.map(t => t.id === task.id ? next : t);
        let identityIndex = 0;
        const transaction = buildStagedLocalTransaction('tasks', intent.accountId, tasks, nextTasks, state.generation + 1,
          intent.capturedAt, () => uuidv5(`reschedule-member-v1:${identityIndex++}`, intent.actionId));
        if (transaction) {
          const ids = new Set([transaction.id, ...transaction.changes.map(change => change.mutationId)]);
          if ([...ids].some(id => state.actionIdentities?.[id] || meta.localState?.receipts[id]
            || meta.localState?.completionReservations?.[id])
            || meta.outbox.some(entry => ids.has(entry.mutationId))
            || meta.conflicts.some(entry => entry.localHistory.some(member => ids.has(member.mutationId)))
            || Object.values(meta.localState?.journal ?? {}).some(entry => ids.has(entry.id)
              || entry.changes.some(change => ids.has(change.mutationId)))) throw new Error('Rescheduling reuses an existing mutation identity.');
          transaction.captureProtocol = 'causal-compatible-v1';
          meta = appendStagedTransactions(meta, [transaction], intent.deviceId);
          meta.localState ??= { generation: 0, journal: {}, receipts: {} };
          meta.localState.journal[transaction.id] = transaction;
          admission.transaction = transaction;
          await writeCausalBusiness(tx, 'tasks', intent.accountId, nextTasks);
        }
        if (task.dateAssigned === intent.day && pushing) {
          if (applyLocalCounter(state, counter).duplicate) throw new Error('The reschedule counter lacks its business admission.');
          admission.counter = counter;
        }
      }
      state.rescheduleAdmissions ??= {};
      state.rescheduleAdmissions[intent.actionId] = admission;
      state.actionIdentities ??= {};
      state.actionIdentities[intent.actionId] = { kind: 'reschedule', intent };
      meta.localState ??= { generation: 0, journal: {}, receipts: {} };
      if (!Number.isSafeInteger(state.generation + 1) || !Number.isSafeInteger(meta.localState.generation + 1)) throw new Error('Local generation exhausted.');
      state.generation++;
      meta.localState.generation++;
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: intent.accountId, payload: state.trackingValue });
      await writeCausalBusiness(tx, 'sync', intent.accountId, { ...(rawMeta && typeof rawMeta === 'object' ? rawMeta : {}), ...meta });
      await tx.done;
      return { duplicate: false, generation: state.generation, admission };
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}
