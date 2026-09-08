import { CAUSAL_STORE, TRACKING_KEY_PATH, fenceLegacyTracking, readCausalAccount } from './causalStorage';
import { projectCounters } from '../src/domain/counterLedger';
import { parseCounterDayCommand, type CounterDayCommand } from './causalProtocol';
import type { CounterAccountState } from './causalCounterCoordinator';
import { stableJson } from './syncProtocol';

export interface CounterDayAccountState extends CounterAccountState {
  counterDayAdmissions?: Record<string, { command: CounterDayCommand; sequence: number }>;
  counterDayOutbox?: Record<string, CounterDayCommand>;
  counterDaySelection?: { actionId: string; requestedDay: string; status: 'PROJECTED' | 'WAITING_BASELINE' };
}

/** Replay local selections after the newest represented local selection.
 * An earlier unsent action must never undo a later already-applied selection.
 * Unknown baselines preserve the last provable projection and expose the
 * requested day separately, rather than labelling yesterday's count today. */
export function projectPendingCounterDays(state: CounterDayAccountState, canonicalDay: string,
  represented: ReadonlySet<string>) {
  const selections = Object.values(state.counterDayAdmissions ?? {}).filter(a => a.command.kind === 'select')
    .sort((a, b) => a.sequence - b.sequence);
  const through = selections.filter(a => represented.has(a.command.actionId)).reduce((max, a) => Math.max(max, a.sequence), 0);
  let day = canonicalDay;
  let selection: CounterDayAccountState['counterDaySelection'];
  for (const { command, sequence } of selections) {
    if (sequence <= through || represented.has(command.actionId)) continue;
    const established = state.counterBaselines?.[command.day];
    if (established) day = command.day;
    selection = { actionId: command.actionId, requestedDay: command.day, status: established ? 'PROJECTED' : 'WAITING_BASELINE' };
  }
  return { day, selection };
}

export function validateCounterDayEvidence(accountId: string, state: CounterDayAccountState) {
  for (const ledger of [state.counterDayAdmissions, state.counterDayOutbox]) {
    if (ledger !== undefined && (ledger === null || typeof ledger !== 'object' || Array.isArray(ledger))) {
      throw new Error('The day journal is invalid.');
    }
  }
  const sequences = new Set<number>();
  for (const [id, admission] of Object.entries(state.counterDayAdmissions ?? {})) {
    if (!admission || typeof admission !== 'object') throw new Error('The day admission is invalid.');
    const command = parseCounterDayCommand(admission.command);
    const identity = state.actionIdentities?.[id];
    if (command.actionId !== id || command.accountId !== accountId || !Number.isSafeInteger(admission.sequence)
      || admission.sequence < 1 || admission.sequence > state.generation || sequences.has(admission.sequence)
      || identity?.kind !== 'counterDay' || stableJson(identity.intent) !== stableJson(command)) {
      throw new Error('The day admission differs from its durable identity or sequence.');
    }
    sequences.add(admission.sequence);
  }
  for (const [id, command] of Object.entries(state.counterDayOutbox ?? {})) {
    if (!state.counterDayAdmissions?.[id] || stableJson(state.counterDayAdmissions[id].command) !== stableJson(command)) {
      throw new Error('The pending day command has no exact admission.');
    }
  }
  if (state.counterDaySelection !== undefined) {
    const selection = state.counterDaySelection;
    const command = selection && state.counterDayAdmissions?.[selection.actionId]?.command;
    if (!command || command.kind !== 'select' || command.day !== selection.requestedDay
      || !['PROJECTED', 'WAITING_BASELINE'].includes(selection.status)) {
      throw new Error('The visible day request has no exact selection admission.');
    }
  }
}

/** Capture day intent without inventing an offline baseline. Known days may
 * project immediately; unknown days retain the last provable date/counts.
 * Sequence is local generation, never a server revision or wall clock. */
export async function admitLocalCounterDay(databaseName: string, input: CounterDayCommand) {
  const command = parseCounterDayCommand(structuredClone(input));
  const db = await fenceLegacyTracking(databaseName);
  try {
    const tx = db.transaction([CAUSAL_STORE, 'tracking'], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, command.accountId) as CounterDayAccountState | undefined;
      if (!state || !state.trackingPresent || !state.trackingValue
        || typeof state.trackingValue !== 'object' || Array.isArray(state.trackingValue)) {
        throw new Error('Existing tracking needs recovery. Nothing was admitted.');
      }
      validateCounterDayEvidence(command.accountId, state);
      const identity = state.actionIdentities?.[command.actionId];
      if (identity && (identity.kind !== 'counterDay' || stableJson(identity.intent) !== stableJson(command))) {
        throw new Error('The action ID has different intent.');
      }
      const prior = state.counterDayAdmissions?.[command.actionId];
      if (prior) {
        if (stableJson(prior.command) !== stableJson(command)) throw new Error('The action ID has different intent.');
        await tx.done;
        return { duplicate: true, sequence: prior.sequence };
      }
      if (identity) throw new Error('The day action requires its original admission evidence.');
      if (!Number.isSafeInteger(state.generation + 1)) throw new Error('Local generation exhausted.');
      const sequence = ++state.generation;
      state.counterDayAdmissions ??= {};
      state.counterDayOutbox ??= {};
      state.actionIdentities ??= {};
      state.counterDayAdmissions[command.actionId] = { command, sequence };
      state.counterDayOutbox[command.actionId] = command;
      state.actionIdentities[command.actionId] = { kind: 'counterDay', intent: command };
      if (command.kind === 'select') {
        const baseline = state.counterBaselines?.[command.day];
        state.counterDaySelection = { actionId: command.actionId, requestedDay: command.day,
          status: baseline ? 'PROJECTED' : 'WAITING_BASELINE' };
        if (baseline) state.trackingValue = { ...state.trackingValue, date: command.day,
          ...projectCounters(baseline, Object.values(state.counterEvents ?? {})) };
      }
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.objectStore('tracking').put({ [TRACKING_KEY_PATH]: command.accountId, payload: state.trackingValue });
      await tx.done;
      return { duplicate: false, sequence };
    } catch (error) {
      try { tx.abort(); } catch (_) { /* already closed */ }
      try { await tx.done; } catch (_) { /* preserve original failure */ }
      throw error;
    }
  } finally { db.close(); }
}
