import { parseCounterDayCommand } from './causalProtocol';
import { assertCausalHistoryEntry } from './causalHistoryProtocol';
import { stableJson } from './syncProtocol';
import type { CausalAccountState } from './causalStorage';
import { parseCausalInitialization, assertCausalInitializationReceipt } from './causalInitializationProtocol';

type State = CausalAccountState & Record<string, any>;
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** Local absence proves no legacy count. Defaults are retained separately from
 * authenticated server history, and pending commands keep their own identities. */
export function validateLocalInitialization(accountId: string, state: State) {
  const initial = state.localInitialization;
  if (initial === undefined) {
    if (state.localInitializationHistory !== undefined || state.serverInitializationRequest !== undefined
      || state.serverInitializationReceipt !== undefined) throw new Error('The original local initialization is missing.');
    return;
  }
  const value = initial?.trackingValue as Record<string, unknown> | undefined;
  const admission = state.counterDayAdmissions?.[initial?.dayActionId];
  if (!initial || initial.schemaVersion !== 1 || !value || typeof value !== 'object' || Array.isArray(value)
    || state.cutover.trackingPresent || state.cutover.trackingValue !== undefined
    || value.planViewCount !== 0 || value.dailyPostponeCount !== 0 || value.focusSession != null || !admission) {
    throw new Error('The preserved local initialization requires recovery.');
  }
  const command = parseCounterDayCommand(admission.command);
  if (command.accountId !== accountId || command.actionId !== initial.dayActionId || command.kind !== 'select'
    || command.day !== value.date || admission.sequence !== 1
    || state.actionIdentities?.[command.actionId]?.kind !== 'counterDay'
    || !same(state.actionIdentities[command.actionId].intent, command)) throw new Error('The initial day intent differs from its evidence.');
  const proof = state.localInitializationHistory;
  if (proof !== undefined) {
    const entry = state.causalHistory?.entries?.['0'];
    if (!proof || proof.schemaVersion !== 1 || typeof proof.body !== 'string' || !entry
      || proof.body !== entry.body || proof.sha256 !== entry.sha256) throw new Error('The initialization history differs from retained evidence.');
    assertCausalHistoryEntry(accountId, state.causalHistory.epoch, 0, JSON.parse(proof.body));
  }
  if (state.serverInitializationRequest !== undefined) {
    if (typeof state.serverInitializationRequest !== 'string') throw new Error('The initialization request is invalid.');
    const operation = parseCausalInitialization(accountId, JSON.parse(state.serverInitializationRequest));
    if (!same(operation.initialTracking, value) || state.actionIdentities?.[operation.initializationId]) {
      throw new Error('The initialization request differs from its original local evidence.');
    }
    if (state.serverInitializationReceipt !== undefined) {
      const receipt = assertCausalInitializationReceipt(accountId, operation, state.serverInitializationReceipt);
      if (proof && !same(JSON.parse(proof.body).receipt, receipt.cutoverReceipt)) throw new Error('Initialization and retained history disagree.');
    }
  } else if (state.serverInitializationReceipt !== undefined) throw new Error('The exact initialization request is missing.');
}

export function bindLocalInitializationHistory(accountId: string, state: State) {
  validateLocalInitialization(accountId, state);
  if (!state.localInitialization) throw new Error('Local absence requires explicit recovery.');
  if (!state.localInitializationHistory) {
    if (Object.keys(state.counterBaselines ?? {}).length) throw new Error('Unverified local baselines require recovery.');
    const entry = state.causalHistory?.entries?.['0'];
    if (!entry) throw new Error('Verified server baseline history is required.');
    state.localInitializationHistory = { schemaVersion: 1, body: entry.body, sha256: entry.sha256 };
  }
  validateLocalInitialization(accountId, state);
}
