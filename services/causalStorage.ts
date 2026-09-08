import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { validateBaselineBindings, type BaselineBinding } from './causalBaselineBinding';

/** Private authority, deliberately absent from the legacy sync/backup store list. */
export const CAUSAL_STORE = 'causal_actions';
export const TRACKING_KEY_PATH = 'causalAccountKey';
export interface CausalAccountState {
  schemaVersion: 1;
  accountKey: IDBValidKey;
  generation: number;
  counterBaselineBindings?: Record<string, BaselineBinding>;
  actionIdentities?: Record<string, { kind: string; intent: unknown }>;
  trackingPresent: boolean;
  trackingValue: unknown;
  /** A newly used local account behind the database-wide fence. This preserves
   * actual prior absence; it is not server enrollment or a counter baseline. */
  localInitialization?: { schemaVersion: 1; trackingValue: unknown; dayActionId: string };
  /** Immutable structured-clone preimages, including malformed/unknown values. */
  cutover: {
    trackingPresent: boolean;
    trackingValue: unknown;
    syncPresent: boolean;
    syncValue: unknown;
  };
}

const closeOnUpgrade = (_a: number, _b: number | null, event: IDBVersionChangeEvent) => {
  (event.target as IDBDatabase).close();
};

/** Dormant until causal admission explicitly invokes it. The versionchange
 * transaction preserves every account before changing the existing key model.
 * Old S1 put(value, accountKey) then fails even after reopening the newest DB.
 * This is a supported-client compatibility fence, not a same-origin security
 * boundary: arbitrary code can still delete stores or open private authority. */
export async function fenceLegacyTracking(databaseName: string): Promise<IDBPDatabase> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await openDB(databaseName, undefined, { blocking: closeOnUpgrade });
    if (!current.objectStoreNames.contains('tracking') || !current.objectStoreNames.contains('sync')) {
      current.close();
      throw new Error('The existing tracking and sync stores must be present before cutover.');
    }
    const keyPath = current.transaction('tracking').store.keyPath;
    if (keyPath === TRACKING_KEY_PATH) {
      if (!current.objectStoreNames.contains(CAUSAL_STORE)) {
        current.close();
        throw new Error('Causal authority is missing. Existing state was not replaced.');
      }
      return current;
    }
    if (keyPath !== null || current.objectStoreNames.contains(CAUSAL_STORE)) {
      current.close();
      throw new Error('An incompatible storage schema needs recovery. Nothing was replaced.');
    }
    const version = current.version + 1;
    current.close();
    let migrationError: unknown;
    try {
      return await openDB(databaseName, version, {
        blocking: closeOnUpgrade,
        upgrade(db, _old, _next, tx) {
          // openDB reports the abort; also observe idb's transaction promise.
          void tx.done.catch(() => undefined);
          // Another tab may have completed cutover between our version reads.
          if (tx.objectStore('tracking').keyPath === TRACKING_KEY_PATH) {
            if (!db.objectStoreNames.contains(CAUSAL_STORE)) tx.abort();
            return;
          }
          const migrate = async () => {
            if (tx.objectStore('tracking').keyPath !== null || db.objectStoreNames.contains(CAUSAL_STORE)) {
              throw new Error('Concurrent incompatible schema change.');
            }
            const tracking = tx.objectStore('tracking');
            const sync = tx.objectStore('sync');
            // Only IDB requests are awaited inside versionchange. No network,
            // crypto or event-loop gaps that can accidentally auto-commit.
            const trackingKeys = await tracking.getAllKeys();
            const trackingValues = await tracking.getAll();
            const syncKeys = await sync.getAllKeys();
            const syncValues = await sync.getAll();
            const authority = db.createObjectStore(CAUSAL_STORE, { keyPath: 'accountKey' });
            const keys = [...trackingKeys];
            for (const key of syncKeys) if (!keys.some(other => indexedDB.cmp(key, other) === 0)) keys.push(key);
            for (const accountKey of keys) {
              const t = trackingKeys.findIndex(key => indexedDB.cmp(key, accountKey) === 0);
              const s = syncKeys.findIndex(key => indexedDB.cmp(key, accountKey) === 0);
              const state: CausalAccountState = {
                schemaVersion: 1, accountKey, generation: 0,
                trackingPresent: t >= 0, trackingValue: trackingValues[t],
                cutover: { trackingPresent: t >= 0, trackingValue: trackingValues[t],
                  syncPresent: s >= 0, syncValue: syncValues[s] }
              };
              await authority.add(state);
            }
            db.deleteObjectStore('tracking');
            const fenced = db.createObjectStore('tracking', { keyPath: TRACKING_KEY_PATH });
            for (let i = 0; i < trackingKeys.length; i++) {
              await fenced.add({ [TRACKING_KEY_PATH]: trackingKeys[i], payload: trackingValues[i] });
            }
            const restoredKeys = await fenced.getAllKeys();
            if (restoredKeys.length !== trackingKeys.length
              || restoredKeys.some((key, i) => indexedDB.cmp(key, trackingKeys[i]) !== 0)
              || await authority.count() !== keys.length) throw new Error('Cutover verification failed.');
          };
          void migrate().catch(error => {
            migrationError = error;
            try { tx.abort(); } catch (_) { /* failed transaction already aborted */ }
          });
        }
      });
    } catch (error) {
      if (migrationError) throw migrationError;
      if ((error as DOMException).name !== 'VersionError') throw error;
    }
  }
  throw new Error('Concurrent schema upgrades prevented cutover. Retry without changing the action identity.');
}

/** Reads protected authority, so a legacy delete/clear cannot erase the current
 * causal projection. The caller must include CAUSAL_STORE in its transaction. */
export async function readCausalAccount(
  tx: IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>, accountKey: IDBValidKey
): Promise<CausalAccountState | undefined> {
  const state = await tx.objectStore(CAUSAL_STORE).get(accountKey) as CausalAccountState | undefined;
  if (state && (state.schemaVersion !== 1 || indexedDB.cmp(state.accountKey, accountKey) !== 0
    || !Number.isSafeInteger(state.generation) || state.generation < 0)) {
    throw new Error('The causal account journal is damaged. Its data remains preserved.');
  }
  if (state?.counterBaselineBindings !== undefined) validateBaselineBindings(String(accountKey), state);
  return state;
}
