import { CAUSAL_STORE, fenceLegacyTracking, readCausalAccount } from './causalStorage';
import { parseCounterDayCommand, type CounterDayCommand } from './causalProtocol';
import type { CounterAccountState } from './causalCounterCoordinator';
import { stableJson } from './syncProtocol';

export interface CounterDayAccountState extends CounterAccountState {
  counterDayAdmissions?: Record<string, { command: CounterDayCommand; sequence: number }>;
  counterDayOutbox?: Record<string, CounterDayCommand>;
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
}

/** Capture day intent without inventing an offline baseline. Admission alone
 * never changes the visible date/counts or focus. The history application
 * coordinator must establish a verified baseline before selecting this day.
 * Sequence is local generation, never a server revision or wall clock. */
export async function admitLocalCounterDay(databaseName: string, input: CounterDayCommand) {
  const command = parseCounterDayCommand(structuredClone(input));
  const db = await fenceLegacyTracking(databaseName);
  try {
    const tx = db.transaction([CAUSAL_STORE], 'readwrite');
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
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.done;
      return { duplicate: false, sequence };
    } catch (error) {
      try { tx.abort(); } catch (_) { /* already closed */ }
      try { await tx.done; } catch (_) { /* preserve original failure */ }
      throw error;
    }
  } finally { db.close(); }
}
