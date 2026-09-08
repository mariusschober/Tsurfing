import { openDB } from 'idb';
import { CAUSAL_STORE, readCausalAccount, type CausalAccountState } from './causalStorage';
import { validateLocalInitialization } from './causalInitialization';
import { parseCausalInitialization, assertCausalInitializationReceipt } from './causalInitializationProtocol';
import { sendCausalInitialization } from './causalCutoverTransport';
import { MAX_RECONCILIATION_BYTES } from './reconciliationStaging';
import { stableJson } from './syncProtocol';
import type { HistoryRuntime } from './causalHistory';

type State = CausalAccountState & Record<string, any>;
async function transaction<T>(name: string, accountId: string, work: (state: State) => T) {
  const db = await openDB(name);
  try {
    const tx = db.transaction([CAUSAL_STORE], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as State | undefined;
      if (!state) throw new Error('The local account is missing.');
      validateLocalInitialization(accountId, state);
      const result = work(state);
      validateLocalInitialization(accountId, state);
      await tx.objectStore(CAUSAL_STORE).put(state); await tx.done; return result;
    } catch (error) {
      try { tx.abort(); } catch (_) {} try { await tx.done; } catch (_) {} throw error;
    }
  } finally { db.close(); }
}

/** Initialization is its own immutable request, not a fabricated legacy push.
 * Its defaults exclude every pending action and never replace server data. */
export async function initializeServerAccount(name: string, accountId: string, runtime: HistoryRuntime): Promise<boolean> {
  const saved = await transaction(name, accountId, state => {
    if (!state.localInitialization) return null;
    if (state.serverInitializationRequest !== undefined) return {
      bytes: state.serverInitializationRequest as string, receipt: state.serverInitializationReceipt
    };
    if (state.causalCapability?.enrolled || state.cutoverRequest !== undefined) throw new Error('Existing enrollment requires history reconciliation.');
    const operation = parseCausalInitialization(accountId, { schemaVersion: 2, accountId,
      initializationId: crypto.randomUUID(), initialTracking: state.localInitialization.trackingValue });
    const bytes = JSON.stringify(operation);
    if (new TextEncoder().encode(bytes).byteLength > MAX_RECONCILIATION_BYTES) throw new Error('Initialization exceeds the supported 4 MiB envelope. Original evidence is retained.');
    state.serverInitializationRequest = bytes;
    return { bytes, receipt: undefined };
  });
  if (saved === null) return false;
  if (saved.receipt !== undefined) return true;
  const receipt = await sendCausalInitialization(accountId, saved.bytes, runtime);
  await transaction(name, accountId, state => {
    if (state.serverInitializationRequest !== saved.bytes) throw new Error('The initialization request changed.');
    const verified = assertCausalInitializationReceipt(accountId, parseCausalInitialization(accountId, JSON.parse(saved.bytes)), receipt);
    if (state.serverInitializationReceipt !== undefined && stableJson(state.serverInitializationReceipt) !== stableJson(verified)) {
      throw new Error('The initialization receipt is immutable.');
    }
    state.serverInitializationReceipt = verified;
  });
  return true;
}
