import { openDB, IDBPDatabase } from 'idb';
import {
  appendStagedTransactions,
  applyConflictCloudValue,
  applyPushResults as transitionPushResults,
  applyRemotePage as transitionRemotePage,
  buildStagedLocalTransaction,
  emptySyncMeta,
  markMutationsAttempted,
  mergeServerConflicts as transitionServerConflicts,
  normalizeSyncMeta,
  RECORD_LEVEL_STORES,
  readyOutbox,
  resolveConflictWithLocal,
  type LocalConflict,
  type PushResult,
  type RemoteSyncRecord,
  type RemoteServerConflict,
  type StagedLocalTransaction,
  type SyncMeta,
  type SyncMutation
} from './syncProtocol';

const BASE_DB_NAME = 'GoalflowDB';
const ACTIVE_DB_KEY = 'goalflow_active_database_v2';
const BACKUP_SCHEMA_VERSION = 4;
const WAL_PREFIX = 'goalflow_wal_v2_';

interface StagedLocalTransactionGroup {
  schemaVersion: 1;
  userKey: string;
  transactions: StagedLocalTransaction[];
}

export interface LocalValueChange {
  storeName: string;
  previousValue: unknown;
  nextValue: unknown;
}

export const STORES = {
  TASKS: 'tasks',
  GOALS: 'goals',
  HABITS: 'habits',
  STATS: 'stats',
  PROGRESS: 'progress',
  HASHTAGS: 'hashtags',
  ACCOUNTABILITY: 'accountability',
  TRUE_NORTH: 'truenorth',
  AMALGAM: 'amalgam',
  TRACKING: 'tracking',
  CIRCADIAN: 'circadian',
  SETTINGS: 'settings',
  DAILY_PLANS: 'daily_plans',
  TASK_EVENTS: 'task_events',
  SYNC: 'sync',
  SNAPSHOTS: 'snapshots'
} as const;

const DATA_STORES: string[] = Object.values(STORES).filter(storeName =>
  storeName !== STORES.SNAPSHOTS && storeName !== STORES.SYNC
);
const SYNCABLE_STORES = new Set<string>(DATA_STORES);

export interface GoalflowBackup {
  schemaVersion: number;
  exportedAt: string;
  ownerKey: string;
  checksum: string;
  collections: Record<string, unknown>;
}

export class DurableStorageError extends Error {
  constructor(message = 'This change could not be saved durably. Nothing was changed.') {
    super(message);
    this.name = 'DurableStorageError';
  }
}

const hasWindow = (): boolean => typeof window !== 'undefined' && Boolean(window.localStorage);
const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const validateBackupCollections = (backup: unknown): Record<string, any> => {
  if (!isRecord(backup)) throw new Error('The backup must be a JSON object.');
  const envelope = backup as Partial<GoalflowBackup>;
  if (envelope.schemaVersion !== undefined
    && (!Number.isInteger(envelope.schemaVersion) || Number(envelope.schemaVersion) < 1)) {
    throw new Error('The backup schema version is invalid.');
  }
  if (envelope.schemaVersion && envelope.schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new Error('This backup was created by a newer Tsurfing version.');
  }
  if (Number(envelope.schemaVersion) >= 3) {
    if (typeof envelope.exportedAt !== 'string' || !Number.isFinite(Date.parse(envelope.exportedAt))) {
      throw new Error('The backup export timestamp is invalid or missing.');
    }
    if (typeof envelope.checksum !== 'string' || !/^[a-f0-9]{64}$/i.test(envelope.checksum)) {
      throw new Error('Backup checksum validation failed. The file may be incomplete or modified.');
    }
  }
  if (Number(envelope.schemaVersion) >= 4 && (typeof envelope.ownerKey !== 'string' || !envelope.ownerKey)) {
    throw new Error('The backup owner binding is invalid or missing.');
  }
  const collections = Object.prototype.hasOwnProperty.call(envelope, 'collections')
    ? envelope.collections
    : backup;
  if (!isRecord(collections)) throw new Error('The backup does not contain typed collections.');
  if (envelope.checksum !== undefined && !/^[a-f0-9]{64}$/i.test(String(envelope.checksum))) {
    throw new Error('Backup checksum validation failed. The file may be incomplete or modified.');
  }
  return collections;
};

const checksumCollections = async (collections: Record<string, unknown>): Promise<string> => {
  const stable = JSON.stringify(collections, (_key, value) => {
    if (!isRecord(value)) return value;
    return Object.keys(value).sort().reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k];
      return acc;
    }, {});
  });
  const bytes = new TextEncoder().encode(stable);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
};

const NATIVE_RAW_JSON_VALUE_KEY = '__goalflowNativeRawJsonV1';

/**
 * Native backups use a few different collection names. Business records can
 * be imported losslessly, but native Room outbox/conflict rows cannot be
 * guessed into browser state: stop visibly if either ledger is non-empty.
 */
export const normalizeBackupCollectionsForWeb = (
  source: Record<string, unknown>
): Record<string, unknown> => {
  const normalized: Record<string, unknown> = { ...source };
  const nativeOutbox = source.outbox;
  const nativeConflicts = source.conflicts;
  for (const [name, value] of [['outbox', nativeOutbox], ['conflicts', nativeConflicts]] as const) {
    if (value !== undefined && !Array.isArray(value)) {
      throw new Error(`Native backup ${name} recovery data is damaged. Existing data is unchanged.`);
    }
    if (Array.isArray(value) && value.length > 0) {
      throw new Error(`Native backup contains pending ${name} recovery data. Restore it in the native app; existing data is unchanged.`);
    }
  }
  if (source.syncMeta !== undefined && !Array.isArray(source.syncMeta)) {
    throw new Error('Native backup synchronization metadata is damaged. Existing data is unchanged.');
  }
  if (normalized[STORES.DAILY_PLANS] === undefined && source.plans !== undefined) {
    normalized[STORES.DAILY_PLANS] = source.plans;
  }
  if (normalized[STORES.TASK_EVENTS] === undefined && source.events !== undefined) {
    normalized[STORES.TASK_EVENTS] = source.events;
  }
  if (source.rawCollections !== undefined) {
    if (!isRecord(source.rawCollections)) {
      throw new Error('Native backup preserved collections are damaged. Existing data is unchanged.');
    }
    for (const [storeName, wrapped] of Object.entries(source.rawCollections)) {
      const value = isRecord(wrapped)
        && Object.keys(wrapped).length === 1
        && typeof wrapped[NATIVE_RAW_JSON_VALUE_KEY] === 'string'
        ? (() => {
            try { return JSON.parse(wrapped[NATIVE_RAW_JSON_VALUE_KEY]); }
            catch (_) { throw new Error(`Native backup collection ${storeName} is damaged. Existing data is unchanged.`); }
          })()
        : wrapped;
      if (!DATA_STORES.includes(storeName) && storeName !== STORES.SYNC) {
        throw new Error(`Native backup collection ${storeName} is not supported by this web version. Existing data is unchanged.`);
      }
      if (normalized[storeName] !== undefined
        && JSON.stringify(normalized[storeName]) !== JSON.stringify(value)) {
        throw new Error(`Native backup contains two different copies of ${storeName}. Existing data is unchanged.`);
      }
      normalized[storeName] = value;
    }
  }
  return normalized;
};

export const mergeBackupCollection = (current: unknown, incoming: unknown): unknown => {
  if (current === undefined) return incoming;
  if (JSON.stringify(current) === JSON.stringify(incoming)) return current;
  if (Array.isArray(current) && Array.isArray(incoming)) {
    if (incoming.every(item => isRecord(item) && typeof item.id === 'string')) {
      const merged = new Map<string, unknown>();
      current.forEach(item => {
        if (!isRecord(item) || typeof item.id !== 'string') {
          throw new Error('Restore stopped because existing record data has no stable identity. Existing data is unchanged.');
        }
        const existing = merged.get(item.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error('Restore stopped because an existing record id is reused for different data. Existing data is unchanged.');
        }
        merged.set(item.id, item);
      });
      incoming.forEach(item => {
        const id = String(item.id);
        const existing = merged.get(id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
          throw new Error('Restore stopped because a backup record conflicts with existing data. Existing data is unchanged.');
        }
        merged.set(id, item);
      });
      return Array.from(merged.values());
    }
    if (current.length === 0) return incoming;
    if (incoming.length === 0) return current;
    throw new Error('Restore stopped because two unkeyed collections differ. Existing data is unchanged.');
  }
  if (isRecord(current) && isRecord(incoming)) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
      if (Object.prototype.hasOwnProperty.call(current, key)
        && JSON.stringify(current[key]) !== JSON.stringify(value)) {
        throw new Error(`Restore stopped because collection key "${key}" conflicts with existing data. Existing data is unchanged.`);
      }
      merged[key] = value;
    }
    return merged;
  }
  throw new Error('Restore stopped because the backup value conflicts with existing data. Existing data is unchanged.');
};

const recoveryKey = (storeName: string, key: string): string => `goalflow_dr_${storeName}_${key}`;
const fallbackKey = (storeName: string, key: string): string => `goalflow_fallback_${storeName}_${key}`;
const deletedKey = (storeName: string, key: string): string => `goalflow_dr_deleted_${storeName}_${key}`;
const walPrefixForUser = (userKey: string): string => `${WAL_PREFIX}${encodeURIComponent(userKey)}_`;
const walKey = (transaction: StagedLocalTransaction): string => `${walPrefixForUser(transaction.userKey)}${transaction.id}`;

const verifiedLocalStorageWrite = (key: string, value: string): void => {
  if (!hasWindow()) throw new DurableStorageError('Durable browser storage is unavailable. Nothing was changed.');
  try {
    window.localStorage.setItem(key, value);
    if (window.localStorage.getItem(key) !== value) throw new Error('read-back mismatch');
  } catch (error) {
    throw new DurableStorageError(`Durable browser storage rejected the change: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

const safeLocalStorageRemove = (key: string): void => {
  if (!hasWindow()) return;
  try { window.localStorage.removeItem(key); } catch (_) {}
};

const writeRecovery = (storeName: string, key: string, value: unknown): void => {
  if (!hasWindow()) return;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return;
    window.localStorage.setItem(recoveryKey(storeName, key), serialized);
    window.localStorage.removeItem(deletedKey(storeName, key));
  } catch (error) {
    console.warn('[Storage] Optional recovery mirror could not be updated.', error);
  }
};

const writeFallback = (storeName: string, key: string, value: unknown): void => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new DurableStorageError();
  verifiedLocalStorageWrite(fallbackKey(storeName, key), serialized);
  safeLocalStorageRemove(deletedKey(storeName, key));
};

const readFallbackCopy = <T>(storeName: string, key: string): { found: boolean; value?: T } => {
  if (!hasWindow()) return { found: false };
  try {
    const serialized = window.localStorage.getItem(fallbackKey(storeName, key));
    return serialized === null ? { found: false } : { found: true, value: JSON.parse(serialized) as T };
  } catch (_) {
    throw new DurableStorageError('A durable fallback copy is damaged. It was not discarded.');
  }
};

const readLocalCopy = <T>(storeName: string, key: string): T | undefined => {
  if (!hasWindow()) return undefined;
  try {
    if (window.localStorage.getItem(deletedKey(storeName, key)) === '1') return undefined;
    const serialized = window.localStorage.getItem(fallbackKey(storeName, key))
      ?? window.localStorage.getItem(recoveryKey(storeName, key));
    return serialized === null ? undefined : JSON.parse(serialized) as T;
  } catch (error) {
    console.warn('[Storage] A local recovery copy is unreadable.', error);
    throw new DurableStorageError('A local recovery copy is damaged. It was not discarded.');
  }
};

interface WalEntry {
  key: string;
  transaction: StagedLocalTransaction;
  grouped: boolean;
}

const validStagedTransaction = (value: unknown, userKey: string): value is StagedLocalTransaction =>
  isRecord(value)
  && value.userKey === userKey
  && typeof value.id === 'string'
  && typeof value.storeName === 'string'
  && Number.isSafeInteger(value.order)
  && Array.isArray(value.changes);

const WAL_DEBOUNCE_MS = 200;
const listWalCache = new Map<string, { entries: WalEntry[]; at: number; len: number }>();
const latestWalCache = new Map<string, { found: boolean; value?: unknown; at: number; walKeyCount: number }>();

const scheduleIdle = (cb: () => void): void => {
  if (typeof window !== 'undefined' && typeof (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback === 'function') {
    (window as unknown as { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback(cb, { timeout: 200 });
  } else if (typeof window !== 'undefined') {
    setTimeout(cb, 0);
  } else {
    cb();
  }
};

const invalidateWalCache = (userKey: string): void => {
  for (const key of Array.from(listWalCache.keys())) {
    if (key === userKey || key.startsWith(`${userKey}:`)) listWalCache.delete(key);
  }
  for (const key of Array.from(latestWalCache.keys())) {
    if (key.startsWith(`${userKey}:`)) latestWalCache.delete(key);
  }
};

const listWal = (userKey: string, storeName?: string): WalEntry[] => {
  if (!hasWindow()) return [];
  const cacheKey = `${userKey}:${storeName ?? '*'}`;
  const now = Date.now();
  const cached = listWalCache.get(cacheKey);
  if (cached && now - cached.at < WAL_DEBOUNCE_MS && cached.len === window.localStorage.length) {
    return cached.entries;
  }
  const prefix = walPrefixForUser(userKey);
  const entries: WalEntry[] = [];
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = window.localStorage.getItem(key);
    try {
      const parsed = JSON.parse(raw ?? '') as unknown;
      if (isRecord(parsed) && parsed.schemaVersion === 1 && parsed.userKey === userKey
        && Array.isArray(parsed.transactions)) {
        if (!parsed.transactions.length
          || parsed.transactions.some(transaction => !validStagedTransaction(transaction, userKey))) {
          throw new Error('invalid grouped WAL entry');
        }
        for (const transaction of parsed.transactions as StagedLocalTransaction[]) {
          if (!storeName || transaction.storeName === storeName) entries.push({ key, transaction, grouped: true });
        }
      } else {
        if (!validStagedTransaction(parsed, userKey)) throw new Error('invalid WAL entry');
        if (!storeName || parsed.storeName === storeName) entries.push({ key, transaction: parsed, grouped: false });
      }
    } catch (_) {
      throw new DurableStorageError('A pending local change is damaged. Synchronization stopped without discarding it.');
    }
  }
  const sorted = entries.sort((a, b) => a.transaction.order - b.transaction.order || a.key.localeCompare(b.key));
  listWalCache.set(cacheKey, { entries: sorted, at: now, len: window.localStorage.length });
  if (sorted.length > 50) {
    scheduleIdle(() => {
      listWalCache.set(cacheKey, { entries: sorted, at: Date.now(), len: window.localStorage.length });
    });
  }
  return sorted;
};

let walOrderCounter = 0;
const nextWalOrder = (): number => {
  walOrderCounter = (walOrderCounter + 1) % 1_000;
  return Date.now() * 1_000 + walOrderCounter;
};

const randomUuid = (): string => crypto.randomUUID();

const readDeviceId = (): string => {
  const key = 'goalflow-device-id';
  if (!hasWindow()) return randomUuid();
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;
  const created = randomUuid();
  verifiedLocalStorageWrite(key, created);
  return created;
};

const latestWalValue = <T>(storeName: string, userKey: string): { found: boolean; value?: T } => {
  const cacheKey = `${userKey}:${storeName}`;
  const now = Date.now();
  const cached = latestWalCache.get(cacheKey) as { found: boolean; value?: T; at: number; walKeyCount: number } | undefined;
  if (cached && now - cached.at < WAL_DEBOUNCE_MS && hasWindow() && cached.walKeyCount === window.localStorage.length) {
    return { found: cached.found, value: cached.value as T | undefined };
  }
  const entries = listWal(userKey, storeName);
  if (!entries.length) {
    const result = { found: false as const, walKeyCount: hasWindow() ? window.localStorage.length : 0, at: now };
    latestWalCache.set(cacheKey, result as unknown as { found: boolean; value?: unknown; at: number; walKeyCount: number });
    return { found: false };
  }
  const result = { found: true as const, value: entries[entries.length - 1].transaction.value as T, walKeyCount: hasWindow() ? window.localStorage.length : 0, at: now };
  latestWalCache.set(cacheKey, result as unknown as { found: boolean; value?: unknown; at: number; walKeyCount: number });
  if (entries.length > 50) {
    scheduleIdle(() => {
      // keep memo warm via idle
      latestWalCache.set(cacheKey, { ...result, at: Date.now() } as unknown as { found: boolean; value?: unknown; at: number; walKeyCount: number });
    });
  }
  return { found: true, value: result.value };
};

const announceLocalChange = (storeName: string, key: string, value: unknown): void => {
  if (typeof window === 'undefined' || storeName === STORES.SYNC || storeName === STORES.SNAPSHOTS) return;
  window.dispatchEvent(new CustomEvent('goalflow:local-change', { detail: { storeName, key, value } }));
};

const announceCloudChange = (storeName: string, value: unknown): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('goalflow:cloud-change', { detail: { storeName, value } }));
};

const activeDatabaseName = (): string => {
  if (!hasWindow()) return BASE_DB_NAME;
  try { return window.localStorage.getItem(ACTIVE_DB_KEY) || BASE_DB_NAME; } catch (_) { return BASE_DB_NAME; }
};

const openAndMigrate = async (databaseName: string, versionAttempt?: number): Promise<IDBPDatabase> => {
  const requiredStores = Object.values(STORES);
  const db = await openDB(databaseName, versionAttempt, {
    upgrade(database) {
      for (const storeName of requiredStores) {
        if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName);
      }
    },
    blocking(_currentVersion, _blockedVersion, event) {
      try { (event.target as any).result.close(); } catch (_) {}
    },
    terminated() {
      console.error('[Storage] IndexedDB connection terminated unexpectedly.');
    }
  });
  const missingStores = requiredStores.filter(storeName => !db.objectStoreNames.contains(storeName));
  if (!missingStores.length) return db;
  const nextVersion = db.version + 1;
  db.close();
  return openAndMigrate(databaseName, nextVersion);
};

let useFallbackStorage = false;
let openedDatabaseName = activeDatabaseName();
let dbPromise: Promise<IDBPDatabase | null> | null = null;

const getDB = async (): Promise<IDBPDatabase | null> => {
  if (useFallbackStorage) return null;
  const requestedName = activeDatabaseName();
  if (requestedName !== openedDatabaseName) {
    if (dbPromise) void dbPromise.then(db => db?.close()).catch(() => undefined);
    dbPromise = null;
    openedDatabaseName = requestedName;
  }
  if (!dbPromise) {
    dbPromise = openAndMigrate(openedDatabaseName).catch(error => {
      console.error('[Storage] IndexedDB is unavailable. Local WAL remains authoritative.', error);
      useFallbackStorage = true;
      return null;
    });
  }
  return dbPromise;
};

let mutationQueue: Promise<unknown> = Promise.resolve();
const queueMutation = <T>(operation: () => Promise<T> | T): Promise<T> => {
  const queued = mutationQueue.then(operation);
  mutationQueue = queued.catch(() => undefined);
  return queued;
};

const mergeRestoredSyncMeta = (currentValue: unknown, incomingValue: unknown): SyncMeta => {
  const current = normalizeSyncMeta(currentValue);
  const incoming = normalizeSyncMeta(incomingValue);
  const versions = { ...incoming.versions, ...current.versions };
  for (const [key, value] of Object.entries(incoming.versions)) {
    const currentVersion = current.versions[key];
    if (!currentVersion) continue;
    versions[key] = {
      local: Math.max(value.local, currentVersion.local),
      server: Math.max(value.server ?? 0, currentVersion.server ?? 0) || null
    };
  }
  const outbox = new Map<string, SyncMutation>();
  [...incoming.outbox, ...current.outbox].forEach(item => {
    const existing = outbox.get(item.mutationId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new Error('Restore stopped because one mutation id refers to different pending data. Existing data is unchanged.');
    }
    outbox.set(item.mutationId, item);
  });
  const conflicts = new Map<string, LocalConflict>();
  [...incoming.conflicts, ...current.conflicts].forEach(item => {
    const existing = conflicts.get(item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) {
      throw new Error('Restore stopped because one conflict id refers to different preserved data. Existing data is unchanged.');
    }
    conflicts.set(item.id, item);
  });
  return {
    schemaVersion: 2,
    cursor: Math.max(current.cursor, incoming.cursor),
    versions,
    outbox: Array.from(outbox.values()),
    conflicts: Array.from(conflicts.values()),
    lastSuccessfulSync: current.lastSuccessfulSync ?? incoming.lastSuccessfulSync
  };
};

const jsonEqual = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

const mapRecordsForRecovery = (
  value: unknown,
  storeName: string,
  label: string
): Map<string, Record<string, unknown>> => {
  if (!Array.isArray(value)) throw new DurableStorageError(`${label} ${storeName} data is not a record collection.`);
  const records = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || records.has(item.id)) {
      throw new DurableStorageError(`${label} ${storeName} data has damaged or duplicate identities.`);
    }
    records.set(item.id, item);
  }
  return records;
};

/**
 * Replays a WAL only against the value it was based on. Independent records
 * recovered from IndexedDB are retained; a same-record divergence stops
 * without selecting either version.
 */
const reconcileStagedTransactions = (
  currentValue: unknown,
  transactions: StagedLocalTransaction[]
): unknown => {
  let current = currentValue;
  for (const transaction of [...transactions].sort((left, right) =>
    left.order - right.order || left.id.localeCompare(right.id))) {
    if (current === undefined && RECORD_LEVEL_STORES.has(transaction.storeName)
      && transaction.hasPreviousValue && Array.isArray(transaction.previousValue)
      && transaction.previousValue.length === 0) {
      current = [];
    }
    if (transaction.hasPreviousValue && jsonEqual(current, transaction.previousValue)) {
      current = transaction.value;
      continue;
    }
    if (jsonEqual(current, transaction.value)) continue;
    if (!RECORD_LEVEL_STORES.has(transaction.storeName)) {
      throw new DurableStorageError(
        `Pending ${transaction.storeName} data diverged from recovered storage. Neither version was overwritten.`
      );
    }
    if (!Array.isArray(current)) {
      throw new DurableStorageError(
        `Pending ${transaction.storeName} records could not be reconciled safely. Neither version was overwritten.`
      );
    }
    const currentRecords = mapRecordsForRecovery(current, transaction.storeName, 'Recovered');
    const previousRecords = transaction.hasPreviousValue
      ? mapRecordsForRecovery(transaction.previousValue === undefined ? [] : transaction.previousValue, transaction.storeName, 'Pending prior')
      : undefined;
    const nextRecords = mapRecordsForRecovery(transaction.value, transaction.storeName, 'Pending');

    for (const change of transaction.changes) {
      const existing = currentRecords.get(change.entityId);
      const before = previousRecords?.get(change.entityId);
      const after = nextRecords.get(change.entityId);
      if (!jsonEqual(existing, before) && !jsonEqual(existing, after)) {
        throw new DurableStorageError(
          `Pending ${transaction.storeName} record ${change.entityId} conflicts with recovered data. Neither was overwritten.`
        );
      }
      if (after === undefined) currentRecords.delete(change.entityId);
      else currentRecords.set(change.entityId, after);
    }
    current = Array.from(currentRecords.values());
  }
  return current;
};

const recoverFallbackState = async (userKey: string): Promise<void> => {
  if (useFallbackStorage) return;
  const fallbackValues = new Map<string, unknown>();
  for (const storeName of [...DATA_STORES, STORES.SYNC]) {
    const fallback = readFallbackCopy(storeName, userKey);
    if (fallback.found) fallbackValues.set(storeName, fallback.value);
  }
  if (!fallbackValues.size) return;
  const db = await getDB();
  if (!db) return;
  const stores = Array.from(new Set([...fallbackValues.keys(), STORES.SYNC]));
  const tx = db.transaction(stores, 'readwrite');
  const recoveredValues = new Map<string, unknown>();
  try {
    for (const [storeName, value] of fallbackValues) {
      if (storeName === STORES.SYNC) continue;
      const store = tx.objectStore(storeName);
      const existing = await store.get(userKey);
      const recovered = existing === undefined ? value : mergeBackupCollection(existing, value);
      await store.put(recovered, userKey);
      recoveredValues.set(storeName, recovered);
    }
    const syncStore = tx.objectStore(STORES.SYNC);
    const recoveredMeta = mergeRestoredSyncMeta(
      await syncStore.get(userKey),
      fallbackValues.get(STORES.SYNC)
    );
    await syncStore.put(recoveredMeta, userKey);
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    try { await tx.done; } catch (_) {}
    throw error;
  }
  for (const [storeName, value] of fallbackValues) {
    safeLocalStorageRemove(fallbackKey(storeName, userKey));
    if (storeName !== STORES.SYNC) writeRecovery(storeName, userKey, recoveredValues.get(storeName) ?? value);
  }
};

export const storageService = {
  stageLocalValue(storeName: string, key: string, previousValue: unknown, nextValue: unknown): string | null {
    if (!SYNCABLE_STORES.has(storeName)) return null;
    const now = new Date().toISOString();
    const transaction = buildStagedLocalTransaction(
      storeName, key, previousValue, nextValue, nextWalOrder(), now, randomUuid
    );
    if (!transaction) return null;
    const serialized = JSON.stringify(transaction);
    if (serialized === undefined) throw new DurableStorageError();
    verifiedLocalStorageWrite(walKey(transaction), serialized);
    invalidateWalCache(key);
    return transaction.id;
  },

  /**
   * Stages all parts of one logical UI action in one read-verified localStorage
   * write. Recovery flattens the group only inside one IndexedDB transaction,
   * so a process death cannot retain a completion while dropping its habit or
   * statistics mutation.
   */
  stageLocalValues(key: string, changes: LocalValueChange[]): string | null {
    const stores = new Set<string>();
    const now = new Date().toISOString();
    const baseOrder = nextWalOrder();
    const transactions: StagedLocalTransaction[] = [];
    for (const [index, change] of changes.entries()) {
      if (!SYNCABLE_STORES.has(change.storeName)) {
        throw new DurableStorageError(`Store ${change.storeName} cannot participate in a durable local transaction.`);
      }
      if (stores.has(change.storeName)) {
        throw new DurableStorageError(`Store ${change.storeName} appears twice in one local transaction.`);
      }
      stores.add(change.storeName);
      const transaction = buildStagedLocalTransaction(
        change.storeName,
        key,
        change.previousValue,
        change.nextValue,
        baseOrder + index,
        now,
        randomUuid
      );
      if (transaction) transactions.push(transaction);
    }
    if (!transactions.length) return null;
    const id = randomUuid();
    const group: StagedLocalTransactionGroup = { schemaVersion: 1, userKey: key, transactions };
    const serialized = JSON.stringify(group);
    if (serialized === undefined) throw new DurableStorageError();
    verifiedLocalStorageWrite(`${walPrefixForUser(key)}batch-${id}`, serialized);
    invalidateWalCache(key);
    return id;
  },

  async get<T>(storeName: string, key: string): Promise<T | undefined> {
    if (SYNCABLE_STORES.has(storeName)) {
      const staged = latestWalValue<T>(storeName, key);
      if (staged.found) return staged.value;
    }
    const fallback = readFallbackCopy<T>(storeName, key);
    if (fallback.found) return fallback.value;
    if (!useFallbackStorage) {
      try {
        const db = await getDB();
        if (db) return await db.get(storeName, key) as T | undefined;
      } catch (error) {
        console.warn(`[Storage] IndexedDB read failed for ${storeName}.`, error);
        throw new DurableStorageError(
          `IndexedDB could not verify the current ${storeName} value. An older mirror was not substituted.`
        );
      }
    }
    return readLocalCopy<T>(storeName, key);
  },

  set<T>(storeName: string, key: string, value: T, source: 'local' | 'cloud' = 'local'): Promise<void> {
    if (source === 'local' && listWal(key, storeName).some(item => item.grouped)) {
      return this.flushPendingLocalChanges(key).then(() => this.set(storeName, key, value, source));
    }
    return queueMutation(async () => {
      let pending = source === 'local' ? listWal(key, storeName) : [];
      let committedValue: unknown = pending.length
        ? pending[pending.length - 1].transaction.value
        : value;
      const db = await getDB();
      if (db) {
        const stores = source === 'local' && SYNCABLE_STORES.has(storeName)
          ? [storeName, STORES.SYNC]
          : [storeName];
        const tx = db.transaction(stores, 'readwrite');
        try {
          if (source === 'local' && SYNCABLE_STORES.has(storeName) && pending.length === 0) {
            const previous = await tx.objectStore(storeName).get(key);
            const transaction = buildStagedLocalTransaction(
              storeName, key, previous, value, nextWalOrder(), new Date().toISOString(), randomUuid
            );
            if (transaction) {
              const entryKey = walKey(transaction);
              verifiedLocalStorageWrite(entryKey, JSON.stringify(transaction));
              invalidateWalCache(key);
              pending = [{ key: entryKey, transaction, grouped: false }];
              committedValue = transaction.value;
            }
          }
          const dataStore = tx.objectStore(storeName);
          if (source === 'local' && SYNCABLE_STORES.has(storeName)) {
            committedValue = reconcileStagedTransactions(
              await dataStore.get(key), pending.map(item => item.transaction)
            );
          }
          await dataStore.put(committedValue, key);
          if (stores.includes(STORES.SYNC)) {
            const syncStore = tx.objectStore(STORES.SYNC);
            const meta = normalizeSyncMeta(await syncStore.get(key));
            const nextMeta = appendStagedTransactions(meta, pending.map(item => item.transaction), readDeviceId());
            await syncStore.put(nextMeta, key);
          }
          await tx.done;
        } catch (error) {
          try { tx.abort(); } catch (_) {}
          try { await tx.done; } catch (_) {}
          throw error;
        }
      } else {
        if (source === 'local' && SYNCABLE_STORES.has(storeName) && pending.length === 0) {
          const transaction = buildStagedLocalTransaction(
            storeName, key, readLocalCopy(storeName, key), value,
            nextWalOrder(), new Date().toISOString(), randomUuid
          );
          if (transaction) {
            const entryKey = walKey(transaction);
            verifiedLocalStorageWrite(entryKey, JSON.stringify(transaction));
            invalidateWalCache(key);
            pending = [{ key: entryKey, transaction, grouped: false }];
            committedValue = transaction.value;
          }
        }
        if (source === 'local' && SYNCABLE_STORES.has(storeName)) {
          committedValue = reconcileStagedTransactions(
            readLocalCopy(storeName, key), pending.map(item => item.transaction)
          );
        }
        writeFallback(storeName, key, committedValue);
        if (source === 'local' && SYNCABLE_STORES.has(storeName)) {
          const meta = normalizeSyncMeta(readLocalCopy(STORES.SYNC, key));
          writeFallback(STORES.SYNC, key, appendStagedTransactions(meta, pending.map(item => item.transaction), readDeviceId()));
        }
      }
      pending.forEach(item => safeLocalStorageRemove(item.key));
      if (pending.length) invalidateWalCache(key);
      writeRecovery(storeName, key, committedValue);
      if (source === 'local') announceLocalChange(storeName, key, committedValue);
    });
  },

  async flushPendingLocalChanges(userKey: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      await recoverFallbackState(userKey);
      const pending = listWal(userKey);
      if (!pending.length) return normalizeSyncMeta(await this.get(STORES.SYNC, userKey));
      const latestByStore = new Map<string, StagedLocalTransaction>();
      const pendingByStore = new Map<string, StagedLocalTransaction[]>();
      pending.forEach(item => latestByStore.set(item.transaction.storeName, item.transaction));
      pending.forEach(item => pendingByStore.set(
        item.transaction.storeName,
        [...(pendingByStore.get(item.transaction.storeName) ?? []), item.transaction]
      ));
      const db = await getDB();
      let nextMeta: SyncMeta;
      if (db) {
        const stores = Array.from(new Set([...latestByStore.keys(), STORES.SYNC]));
        const tx = db.transaction(stores, 'readwrite');
        try {
          const syncStore = tx.objectStore(STORES.SYNC);
          nextMeta = appendStagedTransactions(
            normalizeSyncMeta(await syncStore.get(userKey)),
            pending.map(item => item.transaction),
            readDeviceId()
          );
          for (const transaction of latestByStore.values()) {
            const store = tx.objectStore(transaction.storeName);
            const reconciled = reconcileStagedTransactions(
              await store.get(userKey), pendingByStore.get(transaction.storeName) ?? []
            );
            transaction.value = reconciled;
            await store.put(reconciled, userKey);
          }
          await syncStore.put(nextMeta, userKey);
          await tx.done;
        } catch (error) {
          try { tx.abort(); } catch (_) {}
          try { await tx.done; } catch (_) {}
          throw error;
        }
      } else {
        nextMeta = appendStagedTransactions(
          normalizeSyncMeta(readLocalCopy(STORES.SYNC, userKey)),
          pending.map(item => item.transaction),
          readDeviceId()
        );
        for (const transaction of latestByStore.values()) {
          const reconciled = reconcileStagedTransactions(
            readLocalCopy(transaction.storeName, userKey), pendingByStore.get(transaction.storeName) ?? []
          );
          transaction.value = reconciled;
          writeFallback(transaction.storeName, userKey, reconciled);
        }
        writeFallback(STORES.SYNC, userKey, nextMeta);
      }
      pending.forEach(item => safeLocalStorageRemove(item.key));
      invalidateWalCache(userKey);
      for (const transaction of latestByStore.values()) writeRecovery(transaction.storeName, userKey, transaction.value);
      return nextMeta;
    });
  },

  async preparePushBatch(userKey: string, limit = 50): Promise<SyncMutation[]> {
    await this.flushPendingLocalChanges(userKey);
    return queueMutation(async () => {
      const db = await getDB();
      const meta = normalizeSyncMeta(db ? await db.get(STORES.SYNC, userKey) : readLocalCopy(STORES.SYNC, userKey));
      const batch = readyOutbox(meta, limit);
      if (!batch.length) return [];
      const nextMeta = markMutationsAttempted(meta, batch.map(item => item.mutationId), new Date().toISOString());
      if (db) await db.put(STORES.SYNC, nextMeta, userKey);
      else writeFallback(STORES.SYNC, userKey, nextMeta);
      return batch;
    });
  },

  async commitPushResults(userKey: string, batch: SyncMutation[], results: PushResult[]): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      const current = normalizeSyncMeta(db ? await db.get(STORES.SYNC, userKey) : readLocalCopy(STORES.SYNC, userKey));
      const next = transitionPushResults(current, batch, results, new Date().toISOString());
      if (db) await db.put(STORES.SYNC, next, userKey);
      else writeFallback(STORES.SYNC, userKey, next);
      return next;
    });
  },

  async applyRemotePage(
    userKey: string,
    records: RemoteSyncRecord[],
    nextCursor: number,
    ownDeviceId: string
  ): Promise<{ meta: SyncMeta; changedStores: string[] }> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) {
        // Fallback: advance cursor in localStorage so sync does not stall forever
        const fallbackMeta = normalizeSyncMeta(readLocalCopy(STORES.SYNC, userKey) ?? readFallbackCopy(STORES.SYNC, userKey));
        const currentValues: Record<string, unknown> = {};
        for (const storeName of Array.from(new Set(records.map(r => r.entityType)))) {
          currentValues[storeName] = readLocalCopy(storeName, userKey) ?? readFallbackCopy(storeName, userKey);
        }
        const transition = transitionRemotePage(fallbackMeta, currentValues, records, nextCursor, ownDeviceId, new Date().toISOString());
        writeFallback(STORES.SYNC, userKey, transition.meta);
        for (const storeName of transition.changedStores) {
          const value = transition.values[storeName];
          if (value === undefined) safeLocalStorageRemove(recoveryKey(storeName, userKey));
          else writeRecovery(storeName, userKey, value);
          announceCloudChange(storeName, value);
        }
        return { meta: transition.meta, changedStores: transition.changedStores };
      }
      const entityStores = Array.from(new Set(records.map(record => record.entityType)));
      const tx = db.transaction(Array.from(new Set([...entityStores, STORES.SYNC])), 'readwrite');
      const syncStore = tx.objectStore(STORES.SYNC);
      const currentMeta = normalizeSyncMeta(await syncStore.get(userKey));
      const currentValues: Record<string, unknown> = {};
      for (const storeName of entityStores) currentValues[storeName] = await tx.objectStore(storeName).get(userKey);
      const transition = transitionRemotePage(
        currentMeta, currentValues, records, nextCursor, ownDeviceId, new Date().toISOString()
      );
      for (const storeName of transition.changedStores) {
        const value = transition.values[storeName];
        if (value === undefined) await tx.objectStore(storeName).delete(userKey);
        else await tx.objectStore(storeName).put(value, userKey);
      }
      await syncStore.put(transition.meta, userKey);
      await tx.done;
      for (const storeName of transition.changedStores) {
        const value = transition.values[storeName];
        if (value === undefined) safeLocalStorageRemove(recoveryKey(storeName, userKey));
        else writeRecovery(storeName, userKey, value);
        announceCloudChange(storeName, value);
      }
      return { meta: transition.meta, changedStores: transition.changedStores };
    });
  },

  async markSyncSuccessful(userKey: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      const meta = normalizeSyncMeta(db ? await db.get(STORES.SYNC, userKey) : readLocalCopy(STORES.SYNC, userKey));
      meta.lastSuccessfulSync = new Date().toISOString();
      if (db) await db.put(STORES.SYNC, meta, userKey);
      else writeFallback(STORES.SYNC, userKey, meta);
      return meta;
    });
  },

  async mergeServerConflicts(userKey: string, conflicts: RemoteServerConflict[]): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      const current = normalizeSyncMeta(db
        ? await db.get(STORES.SYNC, userKey)
        : readLocalCopy(STORES.SYNC, userKey));
      const next = transitionServerConflicts(current, conflicts);
      if (db) await db.put(STORES.SYNC, next, userKey);
      else writeFallback(STORES.SYNC, userKey, next);
      return next;
    });
  },

  async getConflict(userKey: string, conflictId: string): Promise<LocalConflict | undefined> {
    const meta = normalizeSyncMeta(await this.get(STORES.SYNC, userKey));
    return meta.conflicts.find(item => item.id === conflictId);
  },

  async resolveConflictLocally(userKey: string, conflictId: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      const meta = normalizeSyncMeta(db ? await db.get(STORES.SYNC, userKey) : readLocalCopy(STORES.SYNC, userKey));
      const next = resolveConflictWithLocal(meta, conflictId, readDeviceId(), new Date().toISOString(), randomUuid());
      if (db) await db.put(STORES.SYNC, next, userKey);
      else writeFallback(STORES.SYNC, userKey, next);
      return next;
    });
  },

  async resolveConflictWithCloud(userKey: string, conflictId: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('The cloud version cannot be applied atomically while IndexedDB is unavailable.');
      const currentMeta = normalizeSyncMeta(await db.get(STORES.SYNC, userKey));
      const conflict = currentMeta.conflicts.find(item => item.id === conflictId);
      if (!conflict) return currentMeta;
      const tx = db.transaction([conflict.entityType, STORES.SYNC], 'readwrite');
      const store = tx.objectStore(conflict.entityType);
      const currentValue = await store.get(userKey);
      const nextValue = applyConflictCloudValue(currentValue, conflict);
      if (nextValue === undefined) await store.delete(userKey);
      else await store.put(nextValue, userKey);
      currentMeta.conflicts = currentMeta.conflicts.filter(item => item.id !== conflictId);
      await tx.objectStore(STORES.SYNC).put(currentMeta, userKey);
      await tx.done;
      if (nextValue === undefined) safeLocalStorageRemove(recoveryKey(conflict.entityType, userKey));
      else writeRecovery(conflict.entityType, userKey, nextValue);
      announceCloudChange(conflict.entityType, nextValue);
      return currentMeta;
    });
  },

  async delete(storeName: string, key: string): Promise<void> {
    await queueMutation(async () => {
      const db = await getDB();
      if (db) await db.delete(storeName, key);
      else verifiedLocalStorageWrite(deletedKey(storeName, key), '1');
      safeLocalStorageRemove(recoveryKey(storeName, key));
      safeLocalStorageRemove(fallbackKey(storeName, key));
    });
  },

  async clear(storeName: string): Promise<void> {
    await queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('This store cannot be cleared atomically while IndexedDB is unavailable.');
      await db.clear(storeName);
      if (hasWindow()) {
        const keys: string[] = [];
        for (let index = 0; index < window.localStorage.length; index++) {
          const key = window.localStorage.key(index);
          if (key?.startsWith(`goalflow_dr_${storeName}_`) || key?.startsWith(`goalflow_fallback_${storeName}_`)) keys.push(key);
        }
        keys.forEach(safeLocalStorageRemove);
      }
    });
  },

  async migrateFromLocalStorage<T>(storeName: string, key: string, legacyKey: string, defaultValue: T): Promise<T> {
    const current = await storageService.get<T>(storeName, key);
    if (current !== undefined) return current;
    if (hasWindow()) {
      try {
        const legacy = window.localStorage.getItem(legacyKey);
        if (legacy !== null) {
          const parsed = JSON.parse(legacy) as T;
          await this.set(storeName, key, parsed);
          return parsed;
        }
      } catch (error) {
        console.warn(`[Storage] Legacy migration failed for ${legacyKey}.`, error);
        throw error;
      }
    }
    // Hydration must establish the value that React will treat as its previous
    // state. Otherwise the first UI mutation can be based on an in-memory
    // default while durable storage is still absent, making safe WAL replay
    // indistinguishable from a divergence after a crash.
    await this.set(storeName, key, defaultValue, 'cloud');
    return defaultValue;
  },

  async migrateUserKey(sourceKey: string, targetKey: string): Promise<void> {
    if (!sourceKey || sourceKey === targetKey) return;
    for (const storeName of DATA_STORES) {
      const targetValue = await this.get(storeName, targetKey);
      if (targetValue !== undefined) continue;
      const sourceValue = await this.get(storeName, sourceKey);
      if (sourceValue !== undefined) await this.set(storeName, targetKey, sourceValue);
    }
  },

  async exportBackup(userKey: string): Promise<GoalflowBackup> {
    await this.flushPendingLocalChanges(userKey);
    return queueMutation(async () => {
      const collections: Record<string, unknown> = {};
      const db = await getDB();
      if (db) {
        const tx = db.transaction([...DATA_STORES, STORES.SYNC], 'readonly');
        for (const storeName of DATA_STORES) {
          const value = await tx.objectStore(storeName).get(userKey);
          if (value !== undefined) collections[storeName] = value;
        }
        const meta = await tx.objectStore(STORES.SYNC).get(userKey);
        if (meta !== undefined) collections[STORES.SYNC] = normalizeSyncMeta(meta);
        await tx.done;
      } else {
        for (const storeName of [...DATA_STORES, STORES.SYNC]) {
          const value = readLocalCopy(storeName, userKey);
          if (value !== undefined) collections[storeName] = value;
        }
      }
      return {
        schemaVersion: BACKUP_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        ownerKey: userKey,
        checksum: await checksumCollections(collections),
        collections
      };
    });
  },

  async importBackup(userKey: string, backup: Record<string, any>, mode: 'merge' | 'replace' = 'merge'): Promise<void> {
    const envelope = backup as Partial<GoalflowBackup>;
    const verifiedCollections = validateBackupCollections(backup);
    if (Number(envelope.schemaVersion) >= 4 && envelope.ownerKey !== userKey) {
      throw new Error('This backup belongs to a different Tsurfing account. Existing data is unchanged.');
    }
    if (envelope.checksum && await checksumCollections(verifiedCollections) !== envelope.checksum.toLowerCase()) {
      throw new Error('Backup checksum validation failed. The file may be incomplete or modified.');
    }
    const collections = normalizeBackupCollectionsForWeb(verifiedCollections);
    await this.flushPendingLocalChanges(userKey);
    await this.createLocalSnapshot(userKey, 'before-restore');
    await queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('Restore was not started because IndexedDB is unavailable. Existing data is unchanged.');
      const tx = db.transaction([...DATA_STORES, STORES.SYNC], 'readwrite');
      const syncStore = tx.objectStore(STORES.SYNC);
      let meta = mergeRestoredSyncMeta(await syncStore.get(userKey), collections[STORES.SYNC]);
      const staged: StagedLocalTransaction[] = [];
      const nextValues = new Map<string, unknown>();
      for (const storeName of DATA_STORES) {
        const current = await tx.objectStore(storeName).get(userKey);
        const incoming = collections[storeName];
        const next = mode === 'merge'
          ? (incoming === undefined ? current : mergeBackupCollection(current, incoming))
          : incoming;
        nextValues.set(storeName, next);
        const transaction = buildStagedLocalTransaction(
          storeName, userKey, current, next, nextWalOrder(), new Date().toISOString(), randomUuid
        );
        if (transaction) staged.push(transaction);
      }
      meta = appendStagedTransactions(meta, staged, readDeviceId());
      for (const [storeName, value] of nextValues) {
        if (value === undefined) await tx.objectStore(storeName).delete(userKey);
        else await tx.objectStore(storeName).put(value, userKey);
      }
      await syncStore.put(meta, userKey);
      await tx.done;
      for (const [storeName, value] of nextValues) {
        if (value === undefined) safeLocalStorageRemove(recoveryKey(storeName, userKey));
        else writeRecovery(storeName, userKey, value);
        announceCloudChange(storeName, value);
      }
    });
  },

  async createLocalSnapshot(userKey: string, reason: string): Promise<void> {
    const backup = await this.exportBackup(userKey);
    await queueMutation(async () => {
      const db = await getDB();
      if (!db) return;
      const key = `${userKey}:${Date.now()}:${randomUuid()}`;
      await db.put(STORES.SNAPSHOTS, { ...backup, reason }, key);
      const keys = (await db.getAllKeys(STORES.SNAPSHOTS)).map(String)
        .filter(candidate => candidate.startsWith(`${userKey}:`)).sort();
      for (const oldKey of keys.slice(0, Math.max(0, keys.length - 10))) await db.delete(STORES.SNAPSHOTS, oldKey);
    });
  },

  async getDatabaseStatus(): Promise<{
    status: 'healthy' | 'fallback' | 'error';
    mode: 'indexeddb' | 'memory-fallback';
    version: number;
    storeCount: number;
    stores: string[];
    details?: string;
  }> {
    if (useFallbackStorage) return {
      status: 'fallback', mode: 'memory-fallback', version: 0, storeCount: 0, stores: [],
      details: 'IndexedDB is unavailable. Durable write-ahead records remain intact; cloud application is paused.'
    };
    try {
      const db = await getDB();
      if (!db) throw new Error('IndexedDB unavailable');
      return { status: 'healthy', mode: 'indexeddb', version: db.version, storeCount: db.objectStoreNames.length, stores: Array.from(db.objectStoreNames) };
    } catch (error) {
      return { status: 'error', mode: 'memory-fallback', version: 0, storeCount: 0, stores: [], details: error instanceof Error ? error.message : String(error) };
    }
  },

  async runSelfRepair(userKey: string): Promise<{ success: boolean; message: string }> {
    try {
      const backup = await this.exportBackup(userKey);
      if (backup.checksum !== await checksumCollections(backup.collections)) throw new Error('Pre-repair backup verification failed.');
      return await queueMutation(async () => {
        const oldDb = await getDB();
        const shadowName = `${BASE_DB_NAME}-repair-${randomUuid()}`;
        const shadow = await openAndMigrate(shadowName, 1);
        try {
          const tx = shadow.transaction([...DATA_STORES, STORES.SYNC], 'readwrite');
          for (const storeName of DATA_STORES) {
            const value = backup.collections[storeName];
            if (value !== undefined) await tx.objectStore(storeName).put(value, userKey);
          }
          const meta = backup.collections[STORES.SYNC];
          if (meta !== undefined) await tx.objectStore(STORES.SYNC).put(normalizeSyncMeta(meta), userKey);
          await tx.done;
          const verification: Record<string, unknown> = {};
          const verifyTx = shadow.transaction([...DATA_STORES, STORES.SYNC], 'readonly');
          for (const storeName of DATA_STORES) {
            const value = await verifyTx.objectStore(storeName).get(userKey);
            if (value !== undefined) verification[storeName] = value;
          }
          const syncValue = await verifyTx.objectStore(STORES.SYNC).get(userKey);
          if (syncValue !== undefined) verification[STORES.SYNC] = normalizeSyncMeta(syncValue);
          await verifyTx.done;
          if (await checksumCollections(verification) !== backup.checksum) throw new Error('Shadow database verification failed.');
          verifiedLocalStorageWrite(ACTIVE_DB_KEY, shadowName);
          oldDb?.close();
          openedDatabaseName = shadowName;
          dbPromise = Promise.resolve(shadow);
          useFallbackStorage = false;
          return { success: true, message: 'A verified replacement database is active. The previous database was preserved for rollback.' };
        } catch (error) {
          shadow.close();
          throw error;
        }
      });
    } catch (error) {
      return { success: false, message: `Self-repair stopped without deleting the existing database: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
};

// Test hook: expose storage for durability verification — only when Vite test mode is explicitly enabled.
// Vite will dead-code-eliminate this branch in production (import.meta.env.DEV === false and VITE_TEST_MODE unset).
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  try {
    if (import.meta.env.VITE_TEST_MODE === 'true') {
      (window as unknown as Record<string, unknown>).__storageService = storageService;
      (window as unknown as Record<string, unknown>).__STORES = STORES;
    }
  } catch {}
}
