import { openDB } from 'idb';
import { v5 as uuidv5 } from 'uuid';
import { projectCounters, validateCounterDelta, type CounterDelta } from '../src/domain/counterLedger';
import { applyLocalCounter } from './causalCounterCoordinator';
import type { CounterDayAccountState } from './causalCounterDayCoordinator';
import { CAUSAL_STORE, TRACKING_KEY_PATH, readCausalAccount } from './causalStorage';
import { causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';
import { assertCompletionCapturesMaterialized } from './causalCompletionCoordinator';
import { appendStagedTransactions, buildStagedLocalTransaction, normalizeSyncMeta, stableJson, type StagedLocalTransaction, type SyncMeta } from './syncProtocol';
import { assertNewSyncPayload } from './syncEnvelope';

export interface PlanningVisitIntent {
  schemaVersion: 1;
  actionId: string;
  accountId: string;
  actorId: string;
  deviceId: string;
  day: string;
  timeZone: string;
  capturedAt: string;
}
interface PlanningVisitAdmission {
  intent: PlanningVisitIntent;
  sequence: number;
  counter: CounterDelta;
  penaltyMode: 'off' | 'gentle' | 'classic';
  /** Immutable observed frontier, including this visit. Later remote/local
   * actions cannot retroactively change the threshold decision for this visit. */
  observedCounterEventIds: string[];
  effect: { status: 'WAITING_BASELINE' } | {
    status: 'APPLIED'; count: number; warning: boolean; penaltyAmount: number;
    baselineId: string; transaction?: StagedLocalTransaction;
  };
}
export interface PlanningAccountState extends CounterDayAccountState {
  planningAdmissions?: Record<string, PlanningVisitAdmission>;
}
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
function visitCounter(intent: PlanningVisitIntent): CounterDelta {
  const counter: CounterDelta = { schemaVersion: 1, actionId: intent.actionId, accountId: intent.accountId,
    actorId: intent.actorId, day: intent.day, timeZone: intent.timeZone, capturedAt: intent.capturedAt,
    counter: 'planViewCount', delta: 1, businessActionId: intent.actionId, correctionOf: null };
  validateCounterDelta(counter);
  if (intent.schemaVersion !== 1 || typeof intent.deviceId !== 'string' || !intent.deviceId || intent.deviceId.length > 240) throw new Error('Invalid planning visit.');
  return { ...counter, actionId: uuidv5('planning-counter-v1', intent.actionId) };
}

export function validatePlanningEvidence(accountId: string, state: PlanningAccountState) {
  if (state.planningAdmissions !== undefined && !object(state.planningAdmissions)) throw new Error('The planning journal requires recovery.');
  const sequences = new Set<number>();
  for (const [id, admission] of Object.entries(state.planningAdmissions ?? {})) {
    if (!object(admission) || !object(admission.intent)) throw new Error('The planning admission is invalid.');
    const expected = visitCounter(admission.intent);
    const identity = state.actionIdentities?.[id];
    if (id !== admission.intent.actionId || admission.intent.accountId !== accountId
      || identity?.kind !== 'planningVisit' || !same(identity.intent, admission.intent)
      || !same(expected, admission.counter) || !same(state.counterEvents?.[expected.actionId], expected)
      || state.actionIdentities?.[expected.actionId]?.kind !== 'counter' || !same(state.actionIdentities?.[expected.actionId]?.intent, expected)
      || !Number.isSafeInteger(admission.sequence) || admission.sequence < 1 || admission.sequence > state.generation
      || sequences.has(admission.sequence) || !['off', 'gentle', 'classic'].includes(admission.penaltyMode)
      || !Array.isArray(admission.observedCounterEventIds) || !admission.observedCounterEventIds.includes(expected.actionId)
      || new Set(admission.observedCounterEventIds).size !== admission.observedCounterEventIds.length
      || admission.observedCounterEventIds.some(eventId => !state.counterEvents?.[eventId]
        || state.counterEvents[eventId].actionId !== eventId || state.counterEvents[eventId].day !== admission.intent.day || state.counterEvents[eventId].accountId !== accountId)) {
      throw new Error('The planning admission differs from its retained counter evidence.');
    }
    for (const eventId of admission.observedCounterEventIds) validateCounterDelta(state.counterEvents![eventId]);
    sequences.add(admission.sequence);
    if (!object(admission.effect) || !['WAITING_BASELINE', 'APPLIED'].includes(admission.effect.status)) throw new Error('The planning effect requires recovery.');
    if (admission.effect.status === 'APPLIED') {
      const baseline = state.counterBaselines?.[admission.intent.day];
      if (!baseline) throw new Error('The planning effect has no established baseline.');
      const count = projectCounters(baseline, admission.observedCounterEventIds.map(id => state.counterEvents![id])).planViewCount;
      const amount = count > 6 && admission.penaltyMode !== 'off' ? admission.penaltyMode === 'gentle' ? 25 : 50 : 0;
      if (admission.effect.baselineId !== baseline.baselineId || admission.effect.count !== count
        || admission.effect.warning !== (count === 6) || admission.effect.penaltyAmount !== amount) throw new Error('The planning effect differs from its observed counter.');
      const transaction = admission.effect.transaction;
      if (transaction) {
        const before = transaction.previousValue;
        if (!amount || !object(before) || typeof before.xp !== 'number' || !Number.isFinite(before.xp) || before.xp <= 0) throw new Error('The planning penalty transaction has invalid source progress.');
        let index = 0;
        const expectedTransaction = buildStagedLocalTransaction('progress', accountId, before, { ...before, xp: Math.max(0, before.xp - amount) },
          admission.sequence, admission.intent.capturedAt, () => uuidv5(`planning-penalty-v1:${index++}`, admission.intent.actionId));
        if (!expectedTransaction || !same(transaction, { ...expectedTransaction, captureProtocol: 'causal-compatible-v1' })) throw new Error('The planning penalty differs from its original business transaction.');
      }

    }
  }
}

/** Settle against the captured evidence frontier, never today's whole snapshot.
 * Called inside admission/history application so progress and its ordinary
 * mutation are committed with the applied marker. Later retries are inert. */
export function settlePlanningVisits(state: PlanningAccountState, inputMeta: SyncMeta, inputProgress: unknown) {
  let meta = inputMeta, progress = inputProgress;
  let changed = false;
  for (const admission of Object.values(state.planningAdmissions ?? {}).sort((a, b) => a.sequence - b.sequence)) {
    if (admission.effect.status === 'APPLIED') continue;
    const baseline = state.counterBaselines?.[admission.intent.day];
    if (!baseline) continue;
    const count = projectCounters(baseline, admission.observedCounterEventIds.map(id => {
      const event = state.counterEvents?.[id];
      if (!event) throw new Error('The planning visit lost its observed counter evidence.');
      return event;
    })).planViewCount;
    const amount = count > 6 && admission.penaltyMode !== 'off' ? admission.penaltyMode === 'gentle' ? 25 : 50 : 0;
    const effect: PlanningVisitAdmission['effect'] = { status: 'APPLIED', count, warning: count === 6, penaltyAmount: amount, baselineId: baseline.baselineId };
    if (amount) {
      if (!object(progress) || typeof progress.xp !== 'number' || !Number.isFinite(progress.xp) || progress.xp < 0) throw new Error('Progress requires recovery before applying the planning penalty.');
      const next = { ...progress, xp: Math.max(0, progress.xp - amount) };
      assertNewSyncPayload(next);
      let index = 0;
      const transaction = buildStagedLocalTransaction('progress', admission.intent.accountId, progress, next,
        admission.sequence, admission.intent.capturedAt, () => uuidv5(`planning-penalty-v1:${index++}`, admission.intent.actionId));
      if (transaction) {
        const ids = new Set([transaction.id, ...transaction.changes.map(change => change.mutationId)]);
        if ([...ids].some(id => state.actionIdentities?.[id] || meta.localState?.receipts[id] || meta.localState?.completionReservations?.[id])
          || meta.outbox.some(item => ids.has(item.mutationId))
          || meta.conflicts.some(item => item.localHistory.some(change => ids.has(change.mutationId)))
          || Object.values(meta.localState?.journal ?? {}).some(item => ids.has(item.id)
            || item.changes.some(change => ids.has(change.mutationId)))) throw new Error('The planning penalty reuses an existing mutation identity.');
        transaction.captureProtocol = 'causal-compatible-v1';
        meta = appendStagedTransactions(meta, [transaction], admission.intent.deviceId);
        meta.localState ??= { generation: 0, journal: {}, receipts: {} };
        meta.localState.journal[transaction.id] = transaction;
        effect.transaction = transaction;
        progress = next;
        changed = true;
      }
    }
    admission.effect = effect;
  }
  return { meta, progress, progressChanged: changed };
}

export async function admitLocalPlanningVisit(name: string, captured: PlanningVisitIntent) {
  const intent = structuredClone(captured), counter = visitCounter(intent);
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Planning requires the prepared causal account.');
    const tx = db.transaction(causalBusinessTransactionStores(db, [CAUSAL_STORE, 'tracking', 'progress', 'settings', 'sync']), 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, intent.accountId) as PlanningAccountState | undefined;
      if (!state || !state.trackingPresent) throw new Error('Planning requires retained causal tracking.');
      validatePlanningEvidence(intent.accountId, state);
      const previous = state.planningAdmissions?.[intent.actionId], identity = state.actionIdentities?.[intent.actionId];
      if (previous || identity) {
        if (!previous || identity?.kind !== 'planningVisit' || !same(previous.intent, intent) || !same(identity.intent, intent)) throw new Error('The planning action ID has different intent.');
        await tx.done; return { duplicate: true, generation: state.generation, admission: previous };
      }
      const settings = await readCausalBusiness(tx, 'settings', intent.accountId);
      if (settings !== undefined && !object(settings)) throw new Error('Planning settings require recovery.');
      const penaltyMode = object(settings) ? settings.penaltyMode ?? 'off' : 'off';
      if (!['off', 'gentle', 'classic'].includes(penaltyMode)) throw new Error('The planning penalty setting is invalid.');
      const rawMeta = await readCausalBusiness(tx, 'sync', intent.accountId);
      const originalMeta = normalizeSyncMeta(rawMeta);
      assertCompletionCapturesMaterialized(intent.accountId, originalMeta);
      const originalProgress = await readCausalBusiness(tx, 'progress', intent.accountId);
      if (applyLocalCounter(state, counter).duplicate) throw new Error('The planning counter lacks its business admission.');
      const admission: PlanningVisitAdmission = { intent, sequence: state.generation + 1, counter, penaltyMode,
        observedCounterEventIds: Object.values(state.counterEvents ?? {}).filter(event => event.day === intent.day).map(event => event.actionId).sort(), effect: { status: 'WAITING_BASELINE' } };
      state.planningAdmissions ??= {}; state.planningAdmissions[intent.actionId] = admission;
      state.actionIdentities ??= {}; state.actionIdentities[intent.actionId] = { kind: 'planningVisit', intent };
      const settled = settlePlanningVisits(state, originalMeta, originalProgress);
      const meta = settled.meta;
      meta.localState ??= { generation: 0, journal: {}, receipts: {} };
      if (!Number.isSafeInteger(state.generation + 1) || !Number.isSafeInteger(meta.localState.generation + 1)) throw new Error('Local generation exhausted.');
      state.generation++; meta.localState.generation++;
      validatePlanningEvidence(intent.accountId, state);
      if (settled.progressChanged) await writeCausalBusiness(tx, 'progress', intent.accountId, settled.progress);
      await writeCausalBusiness(tx, 'sync', intent.accountId, { ...(object(rawMeta) ? rawMeta : {}), ...meta });
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: intent.accountId, payload: state.trackingValue });
      await tx.done;
      return { duplicate: false, generation: state.generation, admission };
    } catch (error) {
      try { tx.abort(); } catch (_) {} try { await tx.done; } catch (_) {} throw error;
    }
  } finally { db.close(); }
}
