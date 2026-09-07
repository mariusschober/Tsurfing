import { type CounterBaseline, type CounterDelta, projectCounters, validateCounterBaseline, validateCounterDelta } from '../src/domain/counterLedger';
import { CAUSAL_STORE, TRACKING_KEY_PATH, fenceLegacyTracking, readCausalAccount, type CausalAccountState } from './causalStorage';
import { stableJson } from './syncProtocol';

export interface CounterAccountState extends CausalAccountState {
  counterBaselines?: Record<string, CounterBaseline>;
  counterEvents?: Record<string, CounterDelta>;
  counterOutbox?: Record<string, CounterDelta>;
}

/** Dormant rollout entrypoint. The caller must supply an explicitly established
 * baseline; this never infers a delta from legacy snapshots or drains their WAL.
 * Day selection remains a separate business action. Delayed events update only
 * their attributed ledger, never today's visible counters. */
export async function admitLocalCounter(databaseName: string, captured: CounterDelta, establishedBaseline: CounterBaseline) {
  const event = structuredClone(captured);
  const baseline = structuredClone(establishedBaseline);
  validateCounterDelta(event);
  validateCounterBaseline(baseline);
  if (event.accountId !== baseline.accountId || event.day !== baseline.day) throw new Error('Counter baseline scope differs from the action.');
  const db = await fenceLegacyTracking(databaseName);
  try {
    const tx = db.transaction([CAUSAL_STORE, 'tracking'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, event.accountId) as CounterAccountState | undefined;
      if (!state || !state.trackingPresent || !state.trackingValue || typeof state.trackingValue !== 'object' || Array.isArray(state.trackingValue)) {
        throw new Error('Existing tracking needs recovery. Nothing was admitted.');
      }
      const tracking = state.trackingValue as Record<string, unknown>;
      const priorBaseline = state.counterBaselines?.[event.day];
      if (priorBaseline && stableJson(priorBaseline) !== stableJson(baseline)) throw new Error('The established baseline is immutable.');
      if (!priorBaseline && tracking.date === event.day
        && (tracking.planViewCount !== baseline.counts.planViewCount || tracking.dailyPostponeCount !== baseline.counts.dailyPostponeCount)) {
        throw new Error('The baseline differs from the preserved projection. Explicit recovery is required.');
      }
      const identity = state.actionIdentities?.[event.actionId];
      if (identity && (identity.kind !== 'counter' || stableJson(identity.intent) !== stableJson(event))) throw new Error('The action ID has different intent.');
      const prior = state.counterEvents?.[event.actionId];
      if (prior && stableJson(prior) !== stableJson(event)) throw new Error('The action ID has different intent.');
      if (prior) {
        await tx.done;
        return { duplicate: true, generation: state.generation, tracking: state.trackingValue };
      }
      const events = [...Object.values(state.counterEvents ?? {}), event];
      // Cross-day scope, duplicate and historical-identity checks are deliberate.
      const counts = projectCounters(baseline, events);
      for (const other of Object.values(state.counterBaselines ?? {})) projectCounters(other, events);
      if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Local generation exhausted.');
      state.counterBaselines ??= {};
      state.counterBaselines[event.day] = baseline;
      state.counterEvents ??= {};
      state.counterEvents[event.actionId] = event;
      state.counterOutbox ??= {};
      state.counterOutbox[event.actionId] = event;
      state.actionIdentities ??= {};
      state.actionIdentities[event.actionId] = { kind: 'counter', intent: event };
      state.generation++;
      if (tracking.date === event.day) state.trackingValue = { ...tracking, ...counts };
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: event.accountId, payload: state.trackingValue });
      await tx.done;
      return { duplicate: false, generation: state.generation, tracking: state.trackingValue };
    } catch (error) {
      try { tx.abort(); } catch (_) { /* already closed */ }
      try { await tx.done; } catch (_) { /* preserve original error */ }
      throw error;
    }
  } finally { db.close(); }
}
