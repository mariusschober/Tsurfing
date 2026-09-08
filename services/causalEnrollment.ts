import { openDB } from 'idb';
import { CAUSAL_STORE, readCausalAccount, type CausalAccountState } from './causalStorage';
import { assertCausalCapability, fetchCausalCapability, type CausalCapability } from './causalCapability';
import { parseCausalOperation } from './causalProtocol';
import { parseCausalCompletion } from './causalCompletionProtocol';
import { assertCausalCutoverReceipt, parseCausalCutover } from './causalCutoverProtocol';
import { stableJson } from './syncProtocol';
import { sendCausalCutover } from './causalCutoverTransport';
import { MAX_RECONCILIATION_BYTES } from './reconciliationStaging';

export interface CausalEnrollmentState extends CausalAccountState {
  causalCapability?: CausalCapability;
  causalRequests?: Record<string, string>;
  completionRequests?: Record<string, string>;
  cutoverRequest?: string;
  cutoverReceipt?: Record<string, any>;
}

export function validateCausalEnrollmentEvidence(accountId: string, state: {
  cutoverRequest?: unknown; cutoverReceipt?: unknown; causalCapability?: unknown;
}) {
  if (state.cutoverRequest === undefined) {
    if (state.cutoverReceipt !== undefined) throw new Error('The exact attempted cutover is missing.');
    return;
  }
  if (typeof state.cutoverRequest !== 'string') throw new Error('The saved cutover request is invalid.');
  const operation = parseCausalCutover(accountId, JSON.parse(state.cutoverRequest));
  if (state.cutoverReceipt !== undefined) assertCausalCutoverReceipt(accountId, operation, state.cutoverReceipt);
  if (state.causalCapability !== undefined) {
    const capability = assertCausalCapability(accountId, state.causalCapability);
    if (!capability.enrolled || capability.epoch !== operation.cutoverId) throw new Error('The saved cutover epoch differs from discovery.');
  }
}

async function enrollmentTransaction<T>(name: string, accountId: string,
  work: (state: CausalEnrollmentState) => T): Promise<T> {
  const db = await openDB(name);
  try {
    if (!db.objectStoreNames.contains(CAUSAL_STORE)) throw new Error('Explicit local causal admission is required.');
    const tx = db.transaction([CAUSAL_STORE], 'readwrite');
    void tx.done.catch(() => undefined);
    try {
      const state = await readCausalAccount(tx, accountId) as CausalEnrollmentState | undefined;
      if (!state) throw new Error('Local causal account evidence is missing.');
      validateCausalEnrollmentEvidence(accountId, state);
      const result = work(state);
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      try { await tx.done; } catch (_) {}
      throw error;
    }
  } finally { db.close(); }
}

/** Retain the exact request before any network attempt. Contradictory legacy
 * evidence requires recovery; pending commands never become baseline counts. */
export async function prepareCausalCutover(name: string, accountId: string, input: unknown): Promise<string> {
  const operation = parseCausalCutover(accountId, structuredClone(input));
  const bytes = JSON.stringify(operation);
  return enrollmentTransaction(name, accountId, state => {
    if (state.cutoverRequest !== undefined) {
      const prior = parseCausalCutover(accountId, JSON.parse(state.cutoverRequest));
      if (stableJson(prior) !== stableJson(operation)) throw new Error('The attempted cutover is immutable.');
      return state.cutoverRequest;
    }
    if (state.causalCapability?.enrolled || state.cutoverReceipt) throw new Error('Existing enrollment requires history reconciliation.');
    if (new TextEncoder().encode(bytes).byteLength > MAX_RECONCILIATION_BYTES) {
      throw new Error('The baseline exceeds the supported 4 MiB enrollment envelope. Its original evidence remains preserved.');
    }
    if (!state.cutover.trackingPresent
      || stableJson(state.cutover.trackingValue) !== stableJson(operation.expectedTrackingPayload)) {
      throw new Error('The preserved local baseline differs. Explicit legacy recovery is required.');
    }
    state.cutoverRequest = bytes;
    return bytes;
  });
}

/** Archive proof only. History application remains responsible for projections,
 * and ordinary cursor advancement still requires a verified pull page. */
export async function commitCausalCutoverReceipt(name: string, accountId: string, input: unknown) {
  const receipt = structuredClone(input);
  return enrollmentTransaction(name, accountId, state => {
    if (state.cutoverRequest === undefined) throw new Error('The exact attempted cutover is missing.');
    const operation = parseCausalCutover(accountId, JSON.parse(state.cutoverRequest));
    const verified = assertCausalCutoverReceipt(accountId, operation, receipt);
    if (state.cutoverReceipt !== undefined) {
      if (stableJson(state.cutoverReceipt) !== stableJson(verified)) throw new Error('The retained cutover receipt is immutable.');
      return { duplicate: true };
    }
    if (state.causalCapability?.enrolled && state.causalCapability.epoch !== operation.cutoverId) {
      throw new Error('The discovered epoch differs from the attempted cutover.');
    }
    state.cutoverReceipt = verified;
    return { duplicate: false };
  });
}

/** Explicit enrollment pipeline. A lost response retries the identical request;
 * the caller separately discovers and applies verified canonical history. */
export async function syncCausalCutover(name: string, accountId: string, input: unknown,
  runtime: Parameters<typeof sendCausalCutover>[2]) {
  const bytes = await prepareCausalCutover(name, accountId, input);
  const saved = await enrollmentTransaction(name, accountId, state => state.cutoverReceipt);
  if (saved !== undefined) return { duplicate: true };
  const receipt = await sendCausalCutover(accountId, bytes, runtime);
  return commitCausalCutoverReceipt(name, accountId, receipt);
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
      if (state.cutoverRequest !== undefined) {
        const operation = parseCausalCutover(accountId, JSON.parse(state.cutoverRequest));
        if (operation.cutoverId !== capability.epoch) throw new Error('The discovered epoch differs from an immutable cutover request.');
        if (state.cutoverReceipt !== undefined) assertCausalCutoverReceipt(accountId, operation, state.cutoverReceipt);
      } else if (state.cutoverReceipt !== undefined) throw new Error('The exact attempted cutover is missing.');
      for (const bytes of Object.values(state.causalRequests ?? {})) {
        let parsed: unknown;
        try { parsed = JSON.parse(bytes); } catch (_) { throw new Error('The retained request requires recovery review.'); }
        const operation = parseCausalOperation(accountId, parsed);
        if (operation.epoch !== capability.epoch) throw new Error('The discovered epoch differs from an immutable attempted request.');
      }
      for (const bytes of Object.values(state.completionRequests ?? {})) {
        const operation = parseCausalCompletion(accountId, JSON.parse(bytes));
        if (operation.epoch !== capability.epoch) throw new Error('The discovered epoch differs from an immutable completion request.');
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
