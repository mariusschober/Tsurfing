import { openDB } from 'idb';
import { CAUSAL_STORE, readCausalAccount, type CausalAccountState } from './causalStorage';
import { parseCausalOperation, assertCausalReceipt, type CausalOperation } from './causalProtocol';
import { stableJson } from './syncProtocol';
import type { FocusAccountState } from './causalFocusCoordinator';
import type { CounterAccountState } from './causalCounterCoordinator';
import { sendCausalAction } from './causalTransport';
import type { CausalEnrollmentState } from './causalEnrollment';
import { assertCausalCapability } from './causalCapability';

export interface CausalReceiptState extends CausalAccountState {
  /** Never rewrite an attempted operation, including its account cutover epoch. */
  causalRequests?: Record<string, string>;
  causalReceipts?: Record<string, Record<string, any>>;
}
type State = CausalReceiptState & FocusAccountState & CounterAccountState & CausalEnrollmentState;

async function transaction<T>(name: string, accountId: string, work: (state: State) => T): Promise<T> {
  // Receipt handling must never trigger cutover on an unprepared database.
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Causal account admission is required.');
    const tx = db.transaction([CAUSAL_STORE], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as State | undefined;
      if (!state) throw new Error('Causal account admission is required.');
      const result = work(state);
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch (_) { /* already closed */ }
      try { await tx.done; } catch (_) { /* retain original failure */ }
      throw error;
    }
  } finally { db.close(); }
}

function admitted(state: State, operation: CausalOperation) {
  const id = operation.command.actionId as string;
  const original = operation.type === 'focus' ? state.focusAdmissions?.[id]?.command
    : operation.type === 'counter' ? state.counterEvents?.[id] : undefined;
  if (!original || stableJson(original) !== stableJson(operation.command)) {
    throw new Error('The wire operation does not match its durable local admission.');
  }
  const pending = operation.type === 'focus' ? state.focusOutbox?.[id] : state.counterOutbox?.[id];
  if (pending && stableJson(pending) !== stableJson(original)) throw new Error('The pending causal command differs from its admission.');
  return { id, pending };
}

/** Called only after rollout establishes the account epoch. Persists wire bytes
 * before the first request, retaining the original domain admission separately. */
export async function prepareCausalRequest(name: string, accountId: string, input: unknown): Promise<string> {
  const operation = parseCausalOperation(accountId, structuredClone(input));
  const bytes = JSON.stringify(operation);
  if (new TextEncoder().encode(bytes).byteLength > 256 * 1024) throw new Error('The saved action exceeds the causal request limit. Its admission remains retained.');
  return transaction(name, accountId, state => {
    const capability = state.causalCapability && assertCausalCapability(accountId, state.causalCapability);
    if (!capability?.enrolled || capability.epoch !== operation.epoch) {
      throw new Error('The action requires the discovered account epoch. Its durable admission remains unchanged.');
    }
    const { id, pending } = admitted(state, operation);
    const prior = state.causalRequests?.[id];
    if (prior !== undefined) {
      if (stableJson(JSON.parse(prior)) !== stableJson(operation)) throw new Error('The attempted causal operation is immutable.');
      return prior;
    }
    if (!pending) throw new Error('The causal action is not pending.');
    state.causalRequests ??= {};
    state.causalRequests[id] = bytes;
    return bytes;
  });
}

/** Atomically archive exact evidence and retire only an accepted matching
 * pending command. A rejected receipt stays pending for explicit resolution.
 * Receipt projections are historical: never apply them over newer local work
 * or use their record cursor to skip an authoritative pull page. */
export async function commitCausalReceipt(name: string, accountId: string, actionId: string, input: unknown) {
  const receipt = structuredClone(input);
  return transaction(name, accountId, state => {
    const bytes = state.causalRequests?.[actionId];
    if (bytes === undefined) throw new Error('The exact attempted causal request is missing.');
    const operation = parseCausalOperation(accountId, JSON.parse(bytes));
    if (operation.command.actionId !== actionId) throw new Error('The attempted action identity differs.');
    const verified = assertCausalReceipt(accountId, operation, receipt);
    const { pending } = admitted(state, operation);
    const prior = state.causalReceipts?.[actionId];
    if (prior) {
      if (stableJson(prior) !== stableJson(verified)) throw new Error('The retained causal receipt is immutable.');
      return { accepted: prior.accepted as boolean, duplicate: true };
    }
    if (!pending) throw new Error('The causal action is not pending.');
    state.causalReceipts ??= {};
    state.causalReceipts[actionId] = verified;
    if (verified.accepted) {
      if (operation.type === 'focus') delete state.focusOutbox![actionId];
      else delete state.counterOutbox![actionId];
    }
    return { accepted: verified.accepted as boolean, duplicate: false };
  });
}

/** Durable one-action pipeline. Scheduling and authenticated epoch discovery
 * remain with the rollout coordinator; retries use this same input. */
export async function syncCausalAction(name: string, accountId: string, input: unknown,
  runtime: Parameters<typeof sendCausalAction>[2]) {
  const bytes = await prepareCausalRequest(name, accountId, input);
  const operation = parseCausalOperation(accountId, JSON.parse(bytes));
  const id = operation.command.actionId as string;
  const saved = await transaction(name, accountId, state => state.causalReceipts?.[id]);
  if (saved) {
    assertCausalReceipt(accountId, operation, saved);
    return { accepted: saved.accepted as boolean, duplicate: true };
  }
  const receipt = await sendCausalAction(accountId, bytes, runtime);
  return commitCausalReceipt(name, accountId, id, receipt);
}
