import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { CAUSAL_STORE, TRACKING_KEY_PATH } from './causalStorage';

export const CAUSAL_BUSINESS_STORE = 'causal_business';
export const BUSINESS_KEY_PATH = 'causalAccountKey';
/** All legacy account stores except tracking (already fenced) and snapshots.
 * Keep snapshots as historical artifacts, never authoritative current state. */
export const CAUSAL_BUSINESS_STORES = [
  'tasks', 'goals', 'habits', 'stats', 'progress', 'hashtags', 'accountability',
  'truenorth', 'amalgam', 'circadian', 'settings', 'daily_plans', 'task_events', 'sync'
] as const;
type Transaction = IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>;
interface BusinessRecord {
  schemaVersion: 1;
  storeName: string;
  accountKey: IDBValidKey;
  present: boolean;
  value: unknown;
  cutover: { present: boolean; value: unknown };
}
const closeOnUpgrade = (_a: number, _b: number | null, event: IDBVersionChangeEvent) => {
  (event.target as IDBDatabase).close();
};
function assertStore(store: string) {
  if (!(CAUSAL_BUSINESS_STORES as readonly string[]).includes(store)) throw new Error('Unsupported causal business store.');
}
function assertSchema(db: IDBPDatabase, tx: IDBPTransaction<unknown, string[], 'readonly' | 'readwrite' | 'versionchange'>, fenced: boolean) {
  if (!db.objectStoreNames.contains(CAUSAL_STORE) || tx.objectStore('tracking').keyPath !== TRACKING_KEY_PATH) {
    throw new Error('Tracking authority must be established before the business fence.');
  }
  for (const store of CAUSAL_BUSINESS_STORES) {
    if (tx.objectStore(store).keyPath !== (fenced ? BUSINESS_KEY_PATH : null) || tx.objectStore(store).indexNames.length) {
      throw new Error('Incompatible business storage schema. Existing data was not replaced.');
    }
  }
  if (fenced && JSON.stringify(tx.objectStore(CAUSAL_BUSINESS_STORE).keyPath) !== JSON.stringify(['storeName', 'accountKey'])) {
    throw new Error('Incompatible business authority schema. Existing data was not replaced.');
  }
}

/** Explicit, dormant cutover. One versionchange transaction copies all accounts,
 * including malformed values and exact sync evidence, before fencing old puts.
 * Legacy delete/clear can remove mirrors but cannot erase private authority.
 * This fences supported older code, not arbitrary same-origin JavaScript.
 * Call only once active reads, writes, backup and recovery use this authority. */
export async function fenceLegacyBusinessStores(name: string): Promise<IDBPDatabase> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await openDB(name, undefined, { blocking: closeOnUpgrade });
    let version: number;
    try {
      const fenced = current.objectStoreNames.contains(CAUSAL_BUSINESS_STORE);
      const tx = current.transaction(['tracking', ...CAUSAL_BUSINESS_STORES, ...(fenced ? [CAUSAL_BUSINESS_STORE] : [])]);
      assertSchema(current, tx, fenced);
      await tx.done;
      if (fenced) return current;
      version = current.version + 1;
    } catch (error) { current.close(); throw error; }
    current.close();
    let migrationError: unknown;
    try {
      return await openDB(name, version, {
        blocking: closeOnUpgrade,
        upgrade(db, _old, _next, tx) {
          void tx.done.catch(() => undefined);
          const migrate = async () => {
            const fenced = db.objectStoreNames.contains(CAUSAL_BUSINESS_STORE);
            assertSchema(db, tx, fenced);
            if (fenced) return;
            const authority = db.createObjectStore(CAUSAL_BUSINESS_STORE, { keyPath: ['storeName', 'accountKey'] });
            for (const storeName of CAUSAL_BUSINESS_STORES) {
              const source = tx.objectStore(storeName);
              const keys = await source.getAllKeys(), values = await source.getAll();
              for (let index = 0; index < keys.length; index++) {
                const record: BusinessRecord = { schemaVersion: 1, storeName, accountKey: keys[index],
                  present: true, value: values[index], cutover: { present: true, value: values[index] } };
                await authority.add(record);
              }
              db.deleteObjectStore(storeName);
              const mirror = db.createObjectStore(storeName, { keyPath: BUSINESS_KEY_PATH });
              for (let index = 0; index < keys.length; index++) {
                await mirror.add({ [BUSINESS_KEY_PATH]: keys[index], payload: values[index] });
              }
              const restored = await mirror.getAllKeys();
              if (restored.length !== keys.length || restored.some((key, i) => indexedDB.cmp(key, keys[i]) !== 0)) {
                throw new Error('Business fence verification failed.');
              }
            }
          };
          void migrate().catch(error => { migrationError = error; try { tx.abort(); } catch (_) {} });
        }
      });
    } catch (error) {
      if (migrationError) throw migrationError;
      if ((error as DOMException).name !== 'VersionError') throw error;
    }
  }
  throw new Error('Concurrent upgrades prevented the business fence. Retry without changing captured intent.');
}

/** Include authority in the same transaction as the causal journal and mirrors. */
export function causalBusinessTransactionStores(db: IDBPDatabase, stores: readonly string[]): string[] {
  return [...new Set([...stores, ...(db.objectStoreNames.contains(CAUSAL_BUSINESS_STORE) ? [CAUSAL_BUSINESS_STORE] : [])])];
}
function isFenced(tx: Transaction, store: string): boolean {
  assertStore(store);
  const keyPath = tx.objectStore(store).keyPath;
  if (keyPath === null) {
    if (tx.objectStoreNames.contains(CAUSAL_BUSINESS_STORE)) throw new Error('Partial business fence requires recovery.');
    return false;
  }
  if (keyPath !== BUSINESS_KEY_PATH || !tx.objectStoreNames.contains(CAUSAL_BUSINESS_STORE)) {
    throw new Error('Business authority must be included in the transaction.');
  }
  return true;
}
async function readRecord(tx: Transaction, storeName: string, accountKey: IDBValidKey): Promise<BusinessRecord | undefined> {
  const record = await tx.objectStore(CAUSAL_BUSINESS_STORE).get([storeName, accountKey]) as BusinessRecord | undefined;
  if (record !== undefined && (record === null || typeof record !== 'object' || record.schemaVersion !== 1 || record.storeName !== storeName
    || indexedDB.cmp(record.accountKey, accountKey) !== 0 || typeof record.present !== 'boolean'
    || !record.cutover || typeof record.cutover.present !== 'boolean')) throw new Error('Business authority is damaged. Data remains preserved.');
  if (record === undefined && await tx.objectStore(storeName).getKey(accountKey) !== undefined) {
    throw new Error('Business authority is missing for a retained mirror. Recovery is required.');
  }
  return record;
}
export async function readCausalBusiness(tx: Transaction, store: string, accountKey: IDBValidKey): Promise<unknown> {
  if (!isFenced(tx, store)) return tx.objectStore(store).get(accountKey);
  const record = await readRecord(tx, store, accountKey);
  return record?.present ? record.value : undefined;
}
/** Caller owns transaction commit/abort. Deletion retains both original cutover
 * evidence and a private absent marker; it never reimports a legacy mirror. */
export async function writeCausalBusiness(tx: IDBPTransaction<unknown, string[], 'readwrite'>,
  store: string, accountKey: IDBValidKey, value: unknown, present = true): Promise<void> {
  if (!isFenced(tx, store)) {
    if (present) await tx.objectStore(store).put(value, accountKey);
    else await tx.objectStore(store).delete(accountKey);
    return;
  }
  const prior = await readRecord(tx, store, accountKey);
  await tx.objectStore(CAUSAL_BUSINESS_STORE).put({ schemaVersion: 1, storeName: store, accountKey,
    present, value, cutover: prior?.cutover ?? { present: false, value: undefined } } satisfies BusinessRecord);
  if (present) await tx.objectStore(store).put({ [BUSINESS_KEY_PATH]: accountKey, payload: value });
  else await tx.objectStore(store).delete(accountKey);
}
