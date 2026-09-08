import { openDB } from 'idb';
import { v5 as uuidv5 } from 'uuid';
import { deriveTaskCompletion, validateCompletionDetails, type CompletionDetails } from '../src/domain/taskCompletion';
import { CAUSAL_STORE, readCausalAccount } from './causalStorage';
import { causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { assertCompletionCapturesMaterialized } from './causalCompletionCoordinator';
import { appendStagedTransactions, buildStagedLocalTransaction, normalizeSyncMeta, stableJson, type StagedLocalTransaction } from './syncProtocol';
import { assertNewSyncPayload } from './syncEnvelope';

export interface TaskCompletionIntent {
  schemaVersion: 1;
  actionId: string;
  accountId: string;
  actorId: string;
  deviceId: string;
  taskId: string;
  details: CompletionDetails;
  capturedAt: string;
}
export interface TaskCompletionAdmission {
  intent: TaskCompletionIntent;
  /** Ordinary staged transactions, one per changed collection. Unlike focus
   * completion members these travel the exact existing ordinary receipt
   * contract; successors order through the ordinary outbox dependency chain. */
  transactions: StagedLocalTransaction[];
  earnedXp: number;
  dayComplete: boolean;
  leveledUp: boolean;
}
export interface TaskCompletionAccountState {
  accountKey: string;
  generation: number;
  trackingPresent?: unknown;
  trackingValue?: unknown;
  actionIdentities?: Record<string, { kind: string; intent: unknown }>;
  taskCompletionAdmissions?: Record<string, TaskCompletionAdmission>;
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Task-only completion for fenced accounts. Focus completions keep their
 * atomic v2 receipt; this path derives the same business effects from the
 * current collections inside one transaction so concurrent completions compose
 * instead of racing a stale React snapshot. Ordinary transport, exact ordinary
 * receipts and the existing conflict path are unchanged. */
export async function admitLocalTaskCompletion(name: string, captured: TaskCompletionIntent) {
  const intent = structuredClone(captured);
  validateCompletionDetails(intent.details);
  if (intent.schemaVersion !== 1 || !uuid(intent.actionId) || !uuid(intent.accountId) || !intent.actorId
    || typeof intent.taskId !== 'string' || !intent.taskId
    || typeof intent.deviceId !== 'string' || !intent.deviceId || intent.deviceId.length > 240
    || !Number.isFinite(Date.parse(intent.capturedAt))) throw new Error('Invalid task completion intent. Nothing was completed.');
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Task completion requires the prepared causal account.');
    const tx = db.transaction(causalBusinessTransactionStores(db,
      [CAUSAL_STORE, 'tasks', 'stats', 'goals', 'habits', 'progress', 'task_events', 'sync']), 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, intent.accountId) as TaskCompletionAccountState | undefined;
      if (!state || !state.trackingPresent) throw new Error('Task completion requires retained causal tracking.');
      const prior = state.taskCompletionAdmissions?.[intent.actionId], identity = state.actionIdentities?.[intent.actionId];
      if (prior || identity) {
        if (!prior || !same(prior.intent, intent) || identity?.kind !== 'task-completion' || !same(identity.intent, intent)) {
          throw new Error('The task completion action ID has different or incomplete intent.');
        }
        await tx.done;
        return { duplicate: true, generation: state.generation, admission: prior };
      }
      const rawMeta = await readCausalBusiness(tx, 'sync', intent.accountId);
      let meta = normalizeSyncMeta(rawMeta);
      assertCompletionCapturesMaterialized(intent.accountId, meta);
      const collections: Record<string, any> = {};
      for (const store of ['tasks', 'goals', 'habits', 'stats', 'progress', 'task_events'] as const) {
        const value = await readCausalBusiness(tx, store, intent.accountId);
        if (value === undefined && Object.keys(meta.versions).some(key => key === store || key.startsWith(`${store}:`))) {
          throw new Error('An absent completion collection has retained version evidence and requires recovery.');
        }
        collections[store] = value ?? (store === 'stats' ? {} : store === 'progress' ? { level: 1, xp: 0, xpToNextLevel: 100 } : []);
      }
      const eventId = uuidv5(`task-completion-event-v1:${intent.accountId}`, intent.actionId);
      const derived = deriveTaskCompletion(collections as any, intent.taskId, intent.capturedAt, intent.details, eventId, intent.actionId);
      const admission: TaskCompletionAdmission = { intent, transactions: [],
        earnedXp: derived.earnedXp, dayComplete: derived.dayComplete, leveledUp: derived.leveledUp };
      let memberIndex = 0;
      const staged: StagedLocalTransaction[] = [];
      for (const store of ['tasks', 'stats', 'goals', 'habits', 'progress', 'task_events'] as const) {
        const before = collections[store], after = (derived.collections as any)[store];
        if (same(before, after)) continue;
        const transaction = buildStagedLocalTransaction(store, intent.accountId, before, after, state.generation + 1,
          intent.capturedAt, () => uuidv5(`task-completion-member-v1:${store}:${memberIndex++}`, intent.actionId));
        if (!transaction) throw new Error('The task completion produced no transportable change. Nothing was completed.');
        const ids = new Set([transaction.id, ...transaction.changes.map(change => change.mutationId)]);
        if ([...ids].some(id => state.actionIdentities?.[id] || meta.localState?.receipts[id]
          || meta.localState?.completionReservations?.[id])
          || meta.outbox.some(entry => ids.has(entry.mutationId))
          || meta.conflicts.some(entry => entry.localHistory.some(member => ids.has(member.mutationId)))
          || Object.values(meta.localState?.journal ?? {}).some(entry => ids.has(entry.id)
            || entry.changes.some(change => ids.has(change.mutationId)))) throw new Error('Task completion reuses an existing mutation identity.');
        transaction.captureProtocol = 'causal-compatible-v1';
        for (const change of transaction.changes) assertNewSyncPayload(change.payload);
        staged.push(transaction);
      }
      if (!staged.length) throw new Error('The task completion produced no transportable change. Nothing was completed.');
      meta = appendStagedTransactions(meta, staged, intent.deviceId);
      meta.localState ??= { generation: 0, journal: {}, receipts: {} };
      for (const transaction of staged) meta.localState.journal[transaction.id] = transaction;
      admission.transactions = staged;
      for (const store of ['tasks', 'stats', 'goals', 'habits', 'progress', 'task_events'] as const) {
        if (!same(collections[store], (derived.collections as any)[store])) {
          await writeCausalBusiness(tx, store, intent.accountId, (derived.collections as any)[store]);
        }
      }
      state.taskCompletionAdmissions ??= {};
      state.taskCompletionAdmissions[intent.actionId] = admission;
      state.actionIdentities ??= {};
      state.actionIdentities[intent.actionId] = { kind: 'task-completion', intent };
      meta.localState ??= { generation: 0, journal: {}, receipts: {} };
      if (!Number.isSafeInteger(state.generation + 1) || !Number.isSafeInteger(meta.localState.generation + 1)) throw new Error('Local generation exhausted.');
      state.generation++;
      meta.localState.generation++;
      await tx.objectStore(CAUSAL_STORE).put(state);
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
