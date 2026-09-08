import type { CausalAccountState } from './causalStorage';
import { assertCausalReceipt, parseCausalOperation } from './causalProtocol';
import { validateCompletionEvidence } from './causalCompletionCoordinator';
import { CAUSAL_BUSINESS_STORES, type BusinessBackupEvidence } from './causalBusinessStorage';
import { normalizeSyncMeta, stableJson } from './syncProtocol';
import { validateCounterDayEvidence } from './causalCounterDayCoordinator';

/** Tagged JSON preserves absent/undefined fields in retained cutover preimages.
 * Unsupported structured-clone values fail export explicitly rather than being
 * silently discarded by JSON.stringify. This is not a trust/receipt validator. */
export function encodeCausalBackup(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return ['value', value];
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return ['value', value];
  if (typeof value !== 'object' || value === null || ancestors.has(value)
    || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    throw new Error('The causal journal contains a value this backup format cannot preserve. The original database remains unchanged.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || !Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).every(Boolean)) throw new Error('Sparse or extended arrays require explicit backup recovery. The original database remains unchanged.');
      return ['array', value.map(item => encodeCausalBackup(item, ancestors))];
    }
    return ['object', Object.entries(value).map(([key, item]) => [key, encodeCausalBackup(item, ancestors)])];
  } finally { ancestors.delete(value); }
}

export function decodeCausalBackup(value: unknown): unknown {
  const invalid = () => { throw new Error('The causal backup encoding is invalid. Nothing was restored.'); };
  if (!Array.isArray(value)) return invalid();
  if (value.length === 1 && value[0] === 'undefined') return undefined;
  if (value.length !== 2) return invalid();
  const [tag, payload] = value;
  if (tag === 'value') {
    if (payload === null || typeof payload === 'string' || typeof payload === 'boolean'
      || (typeof payload === 'number' && Number.isFinite(payload) && !Object.is(payload, -0))) return payload;
    return invalid();
  }
  if (!Array.isArray(payload)) return invalid();
  if (tag === 'array') return payload.map(decodeCausalBackup);
  if (tag !== 'object') return invalid();
  const result: Record<string, unknown> = {};
  for (const entry of payload) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || Object.hasOwn(result, entry[0])) return invalid();
    Object.defineProperty(result, entry[0], { value: decodeCausalBackup(entry[1]), enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export interface CausalBackupEvidence {
  authority: CausalAccountState & Record<string, any>;
  trackingMirror: unknown;
  sync: unknown;
  captures: Record<string, string>;
  business?: BusinessBackupEvidence;
  [key: string]: unknown;
}

/** Validate the restore binding, without interpreting legacy captures or
 * treating a checksum as server acceptance. Original evidence is retained. */
export function readCausalBackup(accountKey: string, value: unknown, collections?: Record<string, unknown>, businessRequired = false): CausalBackupEvidence {
  const record = (item: unknown): item is Record<string, any> => item !== null && typeof item === 'object' && !Array.isArray(item);
  if (!record(value) || value.schemaVersion !== 1) throw new Error('The causal backup schema is unsupported.');
  const decoded = decodeCausalBackup(value.encoded);
  if (!record(decoded) || !record(decoded.authority) || !record(decoded.captures)
    || Object.values(decoded.captures).some(raw => typeof raw !== 'string')) throw new Error('The causal backup evidence is invalid.');
  const state = decoded.authority;
  if (state.schemaVersion !== 1 || state.accountKey !== accountKey || !Number.isSafeInteger(state.generation)
    || state.generation < 0 || typeof state.trackingPresent !== 'boolean' || !record(state.cutover)
    || typeof state.cutover.trackingPresent !== 'boolean' || typeof state.cutover.syncPresent !== 'boolean') {
    throw new Error('The causal backup account binding is invalid.');
  }
  if (businessRequired !== Object.hasOwn(decoded, 'business')) throw new Error('The business backup schema binding is invalid.');
  let effectiveCollections = collections;
  if (businessRequired) {
    const business = decoded.business;
    const storesMatch = (item: unknown) => record(item) && Object.keys(item).length === CAUSAL_BUSINESS_STORES.length
      && CAUSAL_BUSINESS_STORES.every(store => Object.hasOwn(item, store));
    if (!record(business) || business.schemaVersion !== 1 || !storesMatch(business.records) || !storesMatch(business.mirrors)) {
      throw new Error('The business backup store manifest is incomplete or unsupported.');
    }
    effectiveCollections = { ...collections };
    for (const store of CAUSAL_BUSINESS_STORES) {
      const item = business.records[store], mirror = business.mirrors[store];
      if (item !== undefined && (!record(item) || item.schemaVersion !== 1 || item.storeName !== store || item.accountKey !== accountKey
        || typeof item.present !== 'boolean' || !Object.hasOwn(item, 'value') || !record(item.cutover)
        || typeof item.cutover.present !== 'boolean' || !Object.hasOwn(item.cutover, 'value'))) {
        throw new Error('The business backup record binding is invalid.');
      }
      if (!record(mirror) || typeof mirror.present !== 'boolean' || !Object.hasOwn(mirror, 'value')
        || (item === undefined && mirror.present)) throw new Error('The business backup mirror evidence is invalid.');
      const current = item?.present ? item.value : undefined;
      const projection = store === 'sync' && current !== undefined ? normalizeSyncMeta(current) : current;
      if (!collections || stableJson(collections[store]) !== stableJson(projection)) {
        throw new Error('The business backup projection differs from its authority.');
      }
      // The outer JSON collections are compatibility views; exact undefined
      // fields and cutover values live in tagged authority, used for restore.
      effectiveCollections[store] = current;
    }
    const sync = business.records.sync;
    if (stableJson(encodeCausalBackup(decoded.sync)) !== stableJson(encodeCausalBackup(sync?.present ? sync.value : undefined))) {
      throw new Error('The business backup sync evidence differs from its authority.');
    }
  }
  // Exact receipt validation runs before any database schema or data change.
  const requests = state.causalRequests ?? {};
  const receipts = state.causalReceipts ?? {};
  if (!record(requests) || !record(receipts)) throw new Error('The causal backup request ledger is invalid.');
  for (const [id, bytes] of Object.entries(requests)) {
    if (typeof bytes !== 'string') throw new Error('The saved causal request is invalid.');
    let parsed: unknown;
    try { parsed = JSON.parse(bytes); } catch (_) { throw new Error('The saved causal request JSON is invalid.'); }
    const operation = parseCausalOperation(accountKey, parsed);
    if (operation.command.actionId !== id) throw new Error('The saved causal request identity differs.');
    if (Object.hasOwn(receipts, id)) assertCausalReceipt(accountKey, operation, receipts[id]);
  }
  if (Object.keys(receipts).some(id => !Object.hasOwn(requests, id))) throw new Error('A retained receipt has no exact request.');
  validateCounterDayEvidence(accountKey, state as any);
  validateCompletionEvidence(accountKey, state as any, decoded.sync, effectiveCollections);
  return decoded as CausalBackupEvidence;
}
