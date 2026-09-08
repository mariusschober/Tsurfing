import { openDB } from 'idb';
import { CAUSAL_STORE, readCausalAccount, type CausalAccountState } from './causalStorage';
import { assertCausalCapability, fetchCausalCapability, type CausalCapability } from './causalCapability';
import { parseCausalOperation } from './causalProtocol';

export interface CausalEnrollmentState extends CausalAccountState {
  causalCapability?: CausalCapability;
  causalRequests?: Record<string, string>;
}

/** Persists discovery after the explicit local fence. This never performs
 * server enrollment, changes the storage schema, or applies a projection. */
export async function bindCausalCapability(name: string, accountId: string, input: unknown) {
  const capability = assertCausalCapability(accountId, input);
  if (!capability.enrolled) throw new Error('The account has no causal enrollment. Its local evidence remains preserved.');
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Explicit local causal admission is required before binding an epoch.');
    const tx = db.transaction([CAUSAL_STORE], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as CausalEnrollmentState | undefined;
      if (!state) throw new Error('Local causal account evidence is missing.');
      const prior = state.causalCapability;
      if (prior) assertCausalCapability(accountId, prior);
      if (prior && (!prior.enrolled || prior.epoch !== capability.epoch || prior.projectionRevision > capability.projectionRevision)) {
        throw new Error('The discovered causal epoch or revision needs recovery review. Existing evidence remains unchanged.');
      }
      for (const bytes of Object.values(state.causalRequests ?? {})) {
        let parsed: unknown;
        try { parsed = JSON.parse(bytes); } catch (_) { throw new Error('The retained request requires recovery review.'); }
        const operation = parseCausalOperation(accountId, parsed);
        if (operation.epoch !== capability.epoch) throw new Error('The discovered epoch differs from an immutable attempted request.');
      }
      state.causalCapability = capability;
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.done;
      return capability;
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}

export async function discoverCausalCapability(name: string, accountId: string, runtime: Parameters<typeof fetchCausalCapability>[1]) {
  const capability = await fetchCausalCapability(accountId, runtime);
  if (capability.enrolled) await bindCausalCapability(name, accountId, capability);
  return capability;
}
