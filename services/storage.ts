import { admitLocalReschedule, type RescheduleIntent } from './causalRescheduleCoordinator';
import { openDB, IDBPDatabase, type IDBPTransaction } from 'idb';
import { validateCompletionApplicationEvidence } from './causalCompletionProjection';
import {
  appendStagedTransactions,
  applyAutomaticReconciliation,
  type ReconciliationCandidate,
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
  stableJson,
  resolveConflictWithLocal,
  type LocalConflict,
  type PushResult,
  type RemoteSyncRecord,
  type RemoteServerConflict,
  type StagedLocalTransaction,
  type SyncMeta,
  type SyncMutation
} from './syncProtocol';
import { mergeTrackingFocusSession, normalizeFocusSession } from '../src/domain/focusSession';
import { assertNewSyncPayload, transportablePushBatch } from './syncEnvelope';
import { CAUSAL_STORE, TRACKING_KEY_PATH, fenceLegacyTracking, readCausalAccount } from './causalStorage';
import { CAUSAL_BUSINESS_STORE, CAUSAL_BUSINESS_STORES, BUSINESS_KEY_PATH, causalBusinessTransactionStores,
  fenceLegacyBusinessStores, readCausalBusiness, readCausalBusinessBackup, writeCausalBusiness } from './causalBusinessStorage';
import { encodeCausalBackup, readCausalBackup } from './causalBackup';
import { admitLocalFocusControl, type LocalFocusControl, type FocusAccountState } from './causalFocusCoordinator';
import { admitLocalCounterDay, type CounterDayAccountState } from './causalCounterDayCoordinator';
import { admitLocalCompletionControl, type CompletionControlIntent } from './causalCompletionCoordinator';

const BASE_DB_NAME = 'GoalflowDB';
const ACTIVE_DB_KEY = 'goalflow_active_database_v2';
const BACKUP_SCHEMA_VERSION = 6;
const WAL_PREFIX = 'goalflow_wal_v2_';
const LOCAL_SYNC_CONTEXT = import.meta.env.VITE_LOCAL_SYNC_CONTEXT || 's1-v1-unbundled';

interface StagedLocalTransactionGroup {
  schemaVersion: 1;
  userKey: string;
  transactions: StagedLocalTransaction[];
  admissionVersion?: 1;
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
  constructor(message = 'This change could not be saved durably. Nothing was changed.', public readonly code = 'LOCAL_STORAGE_BLOCKED') {
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
  if (Number(envelope.schemaVersion) >= 5 && !Object.hasOwn(collections, CAUSAL_STORE)) {
    throw new Error('The causal backup journal is missing. Nothing was restored.');
  }
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
    }, Object.create(null));
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
const backupLocalCaptures = (userKey: string): Record<string, string> => {
  const captures: Record<string, string> = {};
  if (!hasWindow()) return captures;
  const prefix = walPrefixForUser(userKey);
  const keys = new Set([...DATA_STORES, STORES.SYNC].flatMap(store => [fallbackKey(store, userKey), recoveryKey(store, userKey), deletedKey(store, userKey)]));
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key || (!key.startsWith(prefix) && !keys.has(key))) continue;
    const raw = window.localStorage.getItem(key);
    if (raw !== null) captures[key] = raw;
  }
  return captures;
};
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

const captureWal = (userKey: string, key: string, serialized: string): void => {
  try { verifiedLocalStorageWrite(key, serialized); }
  catch (error) {
    window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: {
      userKey, state: 'error', localFailure: true, message: 'This action could not be captured. Keep the editable input and retry when local storage is available.'
    } }));
    throw error;
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

const readFallbackCopy = <T>(storeName: string, key: string): { found: boolean; value?: T; raw?: string } => {
  if (!hasWindow()) return { found: false };
  try {
    const serialized = window.localStorage.getItem(fallbackKey(storeName, key));
    return serialized === null ? { found: false } : { found: true, value: JSON.parse(serialized) as T, raw: serialized };
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
  raw: string;
  recoverableGroup: boolean;
}

const validStagedTransaction = (value: unknown, userKey: string): value is StagedLocalTransaction =>
  isRecord(value)
  && value.userKey === userKey
  && typeof value.id === 'string'
  && typeof value.storeName === 'string'
  && Number.isSafeInteger(value.order)
  && Array.isArray(value.changes);

// localStorage length and wall time cannot identify peer WAL revisions.
const listWal = (userKey: string, storeName?: string): WalEntry[] => {
  if (!hasWindow()) return [];
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
          if (!storeName || transaction.storeName === storeName) entries.push({ key, transaction, grouped: true, raw: raw!, recoverableGroup: parsed.admissionVersion === 1 });
        }
      } else {
        if (!validStagedTransaction(parsed, userKey)) throw new Error('invalid WAL entry');
        if (!storeName || parsed.storeName === storeName) entries.push({ key, transaction: parsed, grouped: false, raw: raw!, recoverableGroup: false });
      }
    } catch (_) {
      throw new DurableStorageError('A pending local change is damaged. Synchronization stopped without discarding it.');
    }
  }
  const sorted = entries.sort((a, b) => a.transaction.order - b.transaction.order || a.key.localeCompare(b.key));
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
  const entries = listWal(userKey, storeName);
  return entries.length ? { found: true, value: entries[entries.length - 1].transaction.value as T } : { found: false };
};

const announceLocalChange = (storeName: string, key: string, value: unknown): void => {
  if (typeof window === 'undefined' || storeName === STORES.SYNC || storeName === STORES.SNAPSHOTS) return;
  window.dispatchEvent(new CustomEvent('goalflow:local-change', { detail: { storeName, key, value } }));
};

const announceCloudChange = (userKey: string, storeName: string, value: unknown): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('goalflow:cloud-change', { detail: { userKey, storeName, value } }));
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
      try { (event.target as IDBDatabase).close(); } catch (_) {}
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
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
  const mergeEvidence = <T,>(a: Record<string, T> = {}, b: Record<string, T> = {}): Record<string, T> => {
    const result = { ...a };
    for (const [id, value] of Object.entries(b)) {
      if (result[id] !== undefined && !jsonEqual(result[id], value)) throw new DurableStorageError('Restored local evidence has incompatible identities.');
      result[id] = value;
    }
    return result;
  };
  const localState = {
    ...incoming.localState,
    ...current.localState,
    generation: Math.max(current.localState?.generation ?? 0, incoming.localState?.generation ?? 0),
    journal: mergeEvidence(current.localState?.journal, incoming.localState?.journal),
    receipts: mergeEvidence(current.localState?.receipts, incoming.localState?.receipts),
    blocked: mergeEvidence(current.localState?.blocked, incoming.localState?.blocked),
    migrations: mergeEvidence(current.localState?.migrations, incoming.localState?.migrations),
    groups: mergeEvidence(current.localState?.groups, incoming.localState?.groups),
    resolvedConflicts: mergeEvidence(current.localState?.resolvedConflicts, incoming.localState?.resolvedConflicts),
    reconciliations: mergeEvidence(current.localState?.reconciliations, incoming.localState?.reconciliations),
    completionReservations: mergeEvidence(current.localState?.completionReservations, incoming.localState?.completionReservations),
    fallbackCopies: Object.fromEntries([...new Set([...Object.keys(current.localState?.fallbackCopies ?? {}), ...Object.keys(incoming.localState?.fallbackCopies ?? {})])].map(store =>
      [store, [...new Set([...(current.localState?.fallbackCopies?.[store] ?? []), ...(incoming.localState?.fallbackCopies?.[store] ?? [])])]]))
  };
  return {
    localState,
    schemaVersion: 2,
    cursor: Math.max(current.cursor, incoming.cursor),
    versions,
    outbox: Array.from(outbox.values()),
    conflicts: Array.from(conflicts.values()),
    lastSuccessfulSync: current.lastSuccessfulSync ?? incoming.lastSuccessfulSync
  };
};

const jsonEqual = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);

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
 * recovered from IndexedDB are retained; a same-record divergence enters
 * durable automatic reconciliation when an atomic sync ledger is available.
 */
type DailyTrackingValue = { date: string; planViewCount: number; dailyPostponeCount: number };
const isDailyTrackingValue = (value: unknown): value is DailyTrackingValue => {
  if (!isRecord(value) || Object.keys(value).length !== 3
    || typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)
    || !Number.isFinite(Date.parse(value.date))
    || new Date(value.date).toISOString().slice(0, 10) !== value.date) return false;
  return [value.planViewCount, value.dailyPostponeCount]
    .every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
};

// A plan-view/counter write may have captured an old focus projection before
// a newer remote focus state arrived. Recover that independent same-day edit
// without changing any staged mutation fingerprint. The server's focus merge
// already prevents an old counter writer from reverting a newer session.
const recoverTrackingCounterWrite = (current: unknown, previous: unknown, next: unknown): unknown | undefined => {
  if (!isRecord(current) || !isRecord(previous) || !isRecord(next)) return undefined;
  const trackingShape = (value: Record<string, unknown>): boolean => {
    const { focusSession, ...counters } = value;
    return isDailyTrackingValue(counters)
      && (focusSession === undefined || focusSession === null || normalizeFocusSession(focusSession) !== null);
  };
  if (![current, previous, next].every(trackingShape)
    || current.date !== previous.date || next.date !== previous.date
    || !jsonEqual(previous.focusSession, next.focusSession)) return undefined;
  const currentFocus = normalizeFocusSession(current.focusSession);
  const previousFocus = normalizeFocusSession(previous.focusSession);
  if (!jsonEqual(current.focusSession, previous.focusSession)
    && (!currentFocus || (previousFocus && Date.parse(currentFocus.updatedAt) <= Date.parse(previousFocus.updatedAt)))) return undefined;
  const merged = { ...current };
  for (const key of ['planViewCount', 'dailyPostponeCount']) {
    if (current[key] === previous[key]) merged[key] = next[key];
    else if (next[key] !== previous[key] && current[key] !== next[key]) return undefined;
  }
  return merged;
};

const reconcileStagedTransactions = (
  currentValue: unknown,
  transactions: StagedLocalTransaction[],
  meta?: SyncMeta
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
    // Older clients reset the daily counters in memory before hydrating their
    // durable baseline. Recover only that exact, forward-date reset shape.
    // Keep the original staged mutations/IDs; same-day divergence still fails.
    if (transaction.storeName === STORES.TRACKING && transaction.hasPreviousValue
      && isDailyTrackingValue(current) && isDailyTrackingValue(transaction.previousValue)
      && isDailyTrackingValue(transaction.value)
      && current.date < transaction.previousValue.date
      && transaction.previousValue.date === transaction.value.date
      && transaction.previousValue.planViewCount === 0
      && transaction.previousValue.dailyPostponeCount === 0) {
      current = transaction.value;
      continue;
    }
    if (transaction.storeName === STORES.TRACKING && transaction.hasPreviousValue) {
      const recovered = recoverTrackingCounterWrite(current, transaction.previousValue, transaction.value);
      if (recovered !== undefined) {
        current = recovered;
        continue;
      }
    }
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
        if (!meta) throw new DurableStorageError(
          `Pending ${transaction.storeName} record ${change.entityId} conflicts with recovered data. Neither was overwritten.`
        );
        // Preserve the original mutation identities and timestamps in the same
        // durable transaction as the recovered value. The server decides which
        // edit is current; replay must never silently overwrite either copy.
        const pending = meta.outbox.filter(item => item.entityType === change.entityType && item.entityId === change.entityId);
        let conflict = meta.conflicts.find(item => item.entityType === change.entityType && item.entityId === change.entityId && item.status === 'unresolved');
        if (!conflict && !pending.length) throw new DurableStorageError('Pending recovery history could not be verified.');
        if (!conflict) {
          const latest = [...pending].sort((a, b) => b.version - a.version)[0];
          conflict = {
            id: `recovery-${change.mutationId}`, kind: 'remote-vs-local',
            entityType: change.entityType, entityId: change.entityId,
            localPayload: latest.payload, localDeletedAt: latest.deletedAt,
            localHistory: [], serverPayload: existing ?? null,
            serverMissing: existing === undefined,
            serverDeletedAt: typeof existing?.deletedAt === 'string' ? existing.deletedAt : null,
            serverVersion: meta.versions[`${change.entityType}:${change.entityId}`]?.server ?? 0,
            createdAt: latest.updatedAt, status: 'unresolved'
          };
          meta.conflicts.push(conflict);
        }
        for (const item of pending) {
          if (!conflict.localHistory.some(entry => entry.mutationId === item.mutationId)) {
            conflict.localHistory.push({ mutationId: item.mutationId, payload: item.payload,
              deletedAt: item.deletedAt, updatedAt: item.updatedAt, version: item.version });
          }
        }
        const latest = [...conflict.localHistory].sort((a, b) => b.version - a.version)[0];
        conflict.localPayload = latest.payload;
        conflict.localDeletedAt = latest.deletedAt;
        // Transfer, rather than discard, every pending edit into durable history.
        meta.outbox = meta.outbox.filter(item => item.entityType !== change.entityType || item.entityId !== change.entityId);
        continue;
      }
      if (after === undefined) currentRecords.delete(change.entityId);
      else currentRecords.set(change.entityId, after);
    }
    current = Array.from(currentRecords.values());
  }
  return current;
};

const overlayPendingValues = (committed: Record<string, unknown>, entries: WalEntry[]): Record<string, unknown> => {
  const values = { ...committed };
  for (const key of new Set(entries.map(entry => entry.key))) {
    const candidate = { ...values };
    try {
      for (const entry of entries.filter(entry => entry.key === key)) {
        candidate[entry.transaction.storeName] = reconcileStagedTransactions(candidate[entry.transaction.storeName], [entry.transaction]);
      }
      Object.assign(values, candidate);
    } catch (error) {
      if (!(error instanceof DurableStorageError)) throw error;
      // An ambiguous group has no partial rendering authority. Its original
      // envelope stays in WAL until the materializer classifies it durably.
    }
  }
  return values;
};

const recoverFallbackState = async (userKey: string): Promise<void> => {
  if (useFallbackStorage) return;
  const fallbackValues = new Map<string, unknown>();
  const fallbackBytes = new Map<string, string>();
  for (const storeName of [...DATA_STORES, STORES.SYNC]) {
    const fallback = readFallbackCopy(storeName, userKey);
    if (fallback.found) {
      fallbackValues.set(storeName, fallback.value);
      fallbackBytes.set(storeName, fallback.raw!);
    }
  }
  if (!fallbackValues.size) return;
  const db = await getDB();
  if (!db) return;
  const stores = Array.from(new Set([...fallbackValues.keys(), STORES.SYNC]));
  const tx = db.transaction(accountTransactionStores(db, stores), 'readwrite');
  const recoveredValues = new Map<string, unknown>();
  const beforeValues = new Map<string, unknown>();
  let recoveredMeta: SyncMeta;
  try {
    const committedMeta = normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey));
    for (const [store, raw] of fallbackBytes) {
      if (committedMeta.localState?.fallbackCopies?.[store]?.includes(raw)) fallbackValues.delete(store);
    }
    if (!fallbackValues.size) { await tx.done; return; }
    if (tx.objectStoreNames.contains(CAUSAL_STORE)) {
      const state = await readCausalAccount(tx, userKey) as (NonNullable<Awaited<ReturnType<typeof readCausalAccount>>> & { legacyFallback?: Record<string, string[]> }) | undefined;
      if (!state) throw new DurableStorageError('Fallback account data requires explicit causal recovery.');
      state.legacyFallback ??= {};
      const evidence = localEvidence(committedMeta); evidence.blocked ??= {}; evidence.fallbackCopies ??= {};
      for (const store of fallbackValues.keys()) {
        const raw = fallbackBytes.get(store)!;
        const copies = state.legacyFallback[store] ??= [];
        if (!copies.includes(raw)) copies.push(raw);
        const retained = evidence.fallbackCopies[store] ??= [];
        if (!retained.includes(raw)) retained.push(raw);
        evidence.blocked[`causal-fallback:${store}`] = 'CAUSAL_FALLBACK_REVIEW: the original fallback copy is retained for explicit recovery. It was not merged into causal state.';
      }
      if (!Number.isSafeInteger(state.generation + 1)) throw new DurableStorageError('Local generation exhausted.');
      state.generation++;
      await tx.objectStore(CAUSAL_STORE).put(state);
      await putMeta(tx, userKey, committedMeta);
      await tx.done;
      publishCommit(userKey, committedMeta, []);
      return;
    }
    const fallbackMeta = normalizeSyncMeta(fallbackValues.get(STORES.SYNC));
    if (fallbackMeta.cursor > committedMeta.cursor) throw new DurableStorageError('An interrupted fallback cursor cannot be verified against atomically installed records. Both histories were retained.', 'FALLBACK_HISTORY_CONFLICT');
    for (const [storeName, value] of fallbackValues) {
      if (storeName === STORES.SYNC) continue;
      const existing = await readAccountValue(tx, storeName, userKey);
      beforeValues.set(storeName, existing);
      // A missing projection with a version is not an empty initial store:
      // it can be an acknowledged tombstone. Never resurrect it from a mirror.
      const candidates = RECORD_LEVEL_STORES.has(storeName) && Array.isArray(value)
        ? value.filter(item => !Array.isArray(existing) || !existing.some(row => row.id === item.id)).map(item => item.id)
        : existing === undefined ? ['singleton'] : [];
      if (candidates.some(id => committedMeta.versions[`${storeName}:${id}`])) {
        throw new DurableStorageError('Fallback data disagrees with committed deletion evidence. Both histories were retained.', 'FALLBACK_HISTORY_CONFLICT');
      }
      const recovered = existing === undefined ? value : mergeBackupCollection(existing, value);
      await writeAccountValue(tx, storeName, userKey, recovered);
      recoveredValues.set(storeName, recovered);
    }
    recoveredMeta = mergeRestoredSyncMeta(committedMeta, fallbackMeta);
    for (const [storeName, value] of recoveredValues) {
      const action = buildStagedLocalTransaction(storeName, userKey, beforeValues.get(storeName), value, nextWalOrder(), new Date().toISOString(), randomUuid, true);
      if (!action) continue;
      const unrepresented = action.changes.filter(change => !recoveredMeta.versions[`${change.entityType}:${change.entityId}`]
        && !recoveredMeta.outbox.some(item => item.entityType === change.entityType && item.entityId === change.entityId)
        && !recoveredMeta.conflicts.some(item => item.entityType === change.entityType && item.entityId === change.entityId));
      if (unrepresented.length) {
        const recoveryAction = { ...action, changes: unrepresented };
        recoveredMeta = appendStagedTransactions(recoveredMeta, [recoveryAction], readDeviceId());
        localEvidence(recoveredMeta).journal[recoveryAction.id] = recoveryAction;
      }
    }
    localEvidence(recoveredMeta).fallbackCopies ??= {};
    for (const store of fallbackValues.keys()) {
      const copies = localEvidence(recoveredMeta).fallbackCopies!;
      copies[store] = [...new Set([...(copies[store] ?? []), fallbackBytes.get(store)!])];
    }
    await putMeta(tx, userKey, recoveredMeta);
    await tx.done;
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    try { await tx.done; } catch (_) {}
    throw error;
  }
  for (const [storeName, value] of fallbackValues) {
    // localStorage has no compare-and-delete primitive. Keep the source bytes
    // and acknowledge this exact copy in IDB; a peer replacement cannot be lost.
    if (storeName !== STORES.SYNC) writeRecovery(storeName, userKey, recoveredValues.get(storeName) ?? value);
  }
  publishCommit(userKey, recoveredMeta!, [...recoveredValues.keys()]);
};

type StorageTransaction = IDBPTransaction<unknown, string[], 'readwrite'>;
type AccountReadTransaction = IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>;
const accountTransactionStores = (db: IDBPDatabase, stores: readonly string[]): string[] =>
  causalBusinessTransactionStores(db, [...stores, ...(db.objectStoreNames.contains(CAUSAL_STORE) ? [CAUSAL_STORE] : [])]);
const readAccountValue = async (tx: AccountReadTransaction, store: string, key: string): Promise<any> => {
  if (store === STORES.TRACKING && tx.objectStoreNames.contains(CAUSAL_STORE)) {
    if (tx.objectStore(store).keyPath !== TRACKING_KEY_PATH) throw new DurableStorageError('The tracking fence requires schema recovery.');
    const state = await readCausalAccount(tx, key);
    return state?.trackingPresent ? state.trackingValue : undefined;
  }
  if ((CAUSAL_BUSINESS_STORES as readonly string[]).includes(store)) return readCausalBusiness(tx, store, key);
  return tx.objectStore(store).get(key);
};
const protectedTracking = (value: unknown) => isRecord(value)
  ? Object.fromEntries(['date', 'planViewCount', 'dailyPostponeCount', 'focusSession'].map(key => [key, value[key]])) : value;
const changesCausalTracking = (transaction: StagedLocalTransaction): boolean => transaction.storeName === STORES.TRACKING
  && !jsonEqual(protectedTracking(transaction.previousValue), protectedTracking(transaction.value));
const compatibleCapture = ({ transaction }: WalEntry): boolean => {
  if (transaction.captureProtocol !== 'causal-compatible-v1' || changesCausalTracking(transaction)
    || !SYNCABLE_STORES.has(transaction.storeName) || transaction.storageKey !== transaction.userKey
    || transaction.hasPreviousValue !== true || !transaction.changes.length
    || new Set(transaction.changes.map(change => change.mutationId)).size !== transaction.changes.length
    || transaction.changes.some(change => change.entityType !== transaction.storeName || typeof change.mutationId !== 'string' || !change.mutationId
      || typeof change.updatedAt !== 'string' || !Number.isFinite(Date.parse(change.updatedAt)))) return false;
  if (!RECORD_LEVEL_STORES.has(transaction.storeName)) {
    const change = transaction.changes[0];
    return transaction.changes.length === 1 && change.entityId === 'singleton'
      && jsonEqual(change.payload, transaction.value === undefined ? null : transaction.value)
      && change.deletedAt === (transaction.value === undefined ? transaction.createdAt : null);
  }
  try {
    const before = mapRecordsForRecovery(transaction.previousValue ?? [], transaction.storeName, 'Captured previous');
    const after = mapRecordsForRecovery(transaction.value ?? [], transaction.storeName, 'Captured next');
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(id => !jsonEqual(before.get(id), after.get(id)));
    return changed.length === transaction.changes.length && new Set(transaction.changes.map(change => change.entityId)).size === changed.length
      && transaction.changes.every(change => {
        const next = after.get(change.entityId), previous = before.get(change.entityId);
        return changed.includes(change.entityId) && jsonEqual(change.payload, next ?? previous)
          && change.deletedAt === (next ? typeof next.deletedAt === 'string' && next.deletedAt ? next.deletedAt : null : transaction.createdAt);
      });
  } catch (_) { return false; }
};
const compatibleOverlay = (entries: WalEntry[], fenced: boolean): WalEntry[] => {
  if (!fenced) return entries;
  const blockedGroups = new Set(entries.filter(entry => !compatibleCapture(entry)).map(entry => entry.key));
  return entries.filter(entry => !blockedGroups.has(entry.key));
};
const writeAccountValue = async (tx: StorageTransaction, store: string, key: string, value: unknown, present = value !== undefined): Promise<void> => {
  if (store === STORES.TRACKING && tx.objectStoreNames.contains(CAUSAL_STORE)) {
    if (tx.objectStore(store).keyPath !== TRACKING_KEY_PATH) throw new DurableStorageError('The tracking fence requires schema recovery.');
    const state = await readCausalAccount(tx, key);
    if (!state?.trackingPresent || !present || !isRecord(value)
      || !jsonEqual(protectedTracking(state.trackingValue), protectedTracking(value))) {
      throw new DurableStorageError('Tracking changes require a causal command. The original intent remains available for recovery.', 'CAUSAL_COMMAND_REQUIRED');
    }
    if (!jsonEqual(state.trackingValue, value)) {
      if (!Number.isSafeInteger(state.generation + 1)) throw new DurableStorageError('Local generation exhausted.');
      state.trackingValue = value; state.generation++;
      await tx.objectStore(CAUSAL_STORE).put(state);
      await tx.objectStore(store).put({ [TRACKING_KEY_PATH]: key, payload: value });
    }
    return;
  }
  if ((CAUSAL_BUSINESS_STORES as readonly string[]).includes(store)) return writeCausalBusiness(tx, store, key, value, present);
  if (present) await tx.objectStore(store).put(value, key); else await tx.objectStore(store).delete(key);
};

const localEvidence = (meta: SyncMeta): NonNullable<SyncMeta['localState']> =>
  meta.localState ??= { generation: 0, journal: {}, receipts: {} };

const retainResolvedConflicts = (before: SyncMeta, after: SyncMeta): void => {
  for (const conflict of before.conflicts) {
    if (!after.conflicts.some(item => item.id === conflict.id)) {
      const evidence = localEvidence(after);
      evidence.resolvedConflicts ??= {};
      // Include the full candidate identity so a reused ID cannot overwrite an
      // earlier resolution. This is local audit history, never a wire field.
      evidence.resolvedConflicts[stableJson(conflict)] = conflict;
    }
  }
};

const putMeta = async (tx: StorageTransaction, userKey: string, meta: SyncMeta): Promise<void> => {
  const evidence = localEvidence(meta);
  if (!Number.isSafeInteger(evidence.generation + 1)) throw new DurableStorageError('Local generation exhausted.');
  evidence.generation++;
  const raw = await readAccountValue(tx, STORES.SYNC, userKey);
  await writeAccountValue(tx, STORES.SYNC, userKey, { ...(isRecord(raw) ? raw : {}), ...meta,
    localState: { ...(isRecord(raw?.localState) ? raw.localState : {}), ...meta.localState } });
};

const freshWal = (meta: SyncMeta, entries: WalEntry[]): WalEntry[] => {
  const evidence = localEvidence(meta);
  for (const key of new Set(entries.filter(entry => entry.grouped).map(entry => entry.key))) {
    const group = entries.filter(entry => entry.key === key);
    if (evidence.groups?.[key] !== undefined && evidence.groups[key] !== group[0].raw) throw new DurableStorageError('A grouped capture identity has incompatible envelopes. Both copies were retained.');
    const represented = group.filter(entry => evidence.journal[entry.transaction.id]).length;
    if (represented && represented !== group.length) throw new DurableStorageError('A grouped capture has incomplete journal evidence. Its original envelope was retained.');
  }
  return entries.filter(entry => {
    const prior = evidence.journal[entry.transaction.id];
    if (prior && !jsonEqual(prior, entry.transaction)) throw new DurableStorageError('A captured intent identity has incompatible history. Both copies were retained.');
    return !prior;
  });
};

/** Materialize the entire captured group before inbound transitions inspect pending work. */
const materializeWal = async (tx: StorageTransaction, userKey: string, input: SyncMeta): Promise<SyncMeta> => {
  const entries = freshWal(input, listWal(userKey));
  let meta = input;
  // Evaluate an entire capture envelope against a private candidate before
  // putting any member. IDB still serializes every participating store.
  for (const key of new Set(entries.map(entry => entry.key))) {
    const group = entries.filter(entry => entry.key === key);
    if (tx.objectStoreNames.contains(CAUSAL_STORE) && group.some(entry => !compatibleCapture(entry))) {
      const state = await readCausalAccount(tx, userKey) as (NonNullable<Awaited<ReturnType<typeof readCausalAccount>>> & { legacyWal?: Record<string, string[]> }) | undefined;
      if (!state) throw new DurableStorageError('The captured account requires causal recovery before admission.');
      state.legacyWal ??= {};
      const copies = state.legacyWal[key] ??= [];
      if (!copies.includes(group[0].raw)) copies.push(group[0].raw);
      if (!Number.isSafeInteger(state.generation + 1)) throw new DurableStorageError('Local generation exhausted.');
      state.generation++;
      await tx.objectStore(CAUSAL_STORE).put(state);
      const evidence = localEvidence(meta); evidence.blocked ??= {};
      for (const entry of group) {
        evidence.journal[entry.transaction.id] = entry.transaction;
        evidence.blocked[entry.transaction.id] = 'CAUSAL_CAPTURE_REVIEW: the original capture requires explicit recovery or a causal command. No member was applied.';
      }
      if (group[0].grouped) { evidence.groups ??= {}; evidence.groups[key] = group[0].raw; }
      continue;
    }
    let candidate = appendStagedTransactions(structuredClone(meta), group.map(entry => entry.transaction), readDeviceId());
    const values = new Map<string, unknown>();
    try {
      if (group[0].recoverableGroup && stableJson(candidate.conflicts) !== stableJson(meta.conflicts)) throw new DurableStorageError('A grouped action belongs to an unresolved conflict.');
      for (const entry of group) {
        const intent = entry.transaction;
        const current = values.has(intent.storeName) ? values.get(intent.storeName) : await readAccountValue(tx, intent.storeName, userKey);
        const conflictsBefore = stableJson(candidate.conflicts);
        const value = reconcileStagedTransactions(current, [intent], candidate);
        if (entry.recoverableGroup && stableJson(candidate.conflicts) !== conflictsBefore) {
          throw new DurableStorageError('A grouped action conflicts with the current projection.');
        }
        values.set(intent.storeName, value);
        localEvidence(candidate).journal[intent.id] = intent;
      }
    } catch (error) {
      const recoverable = group[0].recoverableGroup || (!group[0].grouped && Boolean(group[0].transaction.admission));
      if (!recoverable || !(error instanceof DurableStorageError)) throw error;
      // Do not transfer part of a logical completion to outbox/conflict while
      // applying another part. The exact whole action remains blocked evidence.
      candidate = structuredClone(meta);
      const evidence = localEvidence(candidate);
      evidence.blocked ??= {};
      for (const entry of group) {
        evidence.journal[entry.transaction.id] = entry.transaction;
        evidence.blocked[entry.transaction.id] = group[0].grouped
          ? 'STALE_GROUP_INTENT: the grouped action changed before commit. Every member is preserved for review.'
          : 'STALE_FOCUS_INTENT: the captured session changed before commit. The action is preserved for review.';
      }
      values.clear();
    }
    if (group[0].grouped) {
      localEvidence(candidate).groups ??= {};
      localEvidence(candidate).groups![key] = group[0].raw;
    }
    for (const [storeName, value] of values) {
      await writeAccountValue(tx, storeName, userKey, value);
    }
    meta = candidate;
  }
  return meta;
};

const retireMaterializedWal = (userKey: string, meta: SyncMeta): void => {
  const entries = listWal(userKey);
  for (const key of new Set(entries.map(entry => entry.key))) {
    const group = entries.filter(entry => entry.key === key);
    // Causal reviews retain the exact envelope in private authority in the same
    // commit as this journal; retirement never discards their original bytes.
    if (group.every(entry => jsonEqual(meta.localState?.journal[entry.transaction.id], entry.transaction))) {
      safeLocalStorageRemove(key);
    }
  }
};

const publishCommit = (userKey: string, meta: SyncMeta | number, stores: string[], database = activeDatabaseName()): void => {
  if (!hasWindow()) return;
  const detail = { userKey, generation: typeof meta === 'number' ? meta : meta.localState?.generation ?? 0, stores, database, context: LOCAL_SYNC_CONTEXT };
  window.dispatchEvent(new CustomEvent('goalflow:committed', { detail }));
  try { window.localStorage.setItem(`goalflow_commit_v1_${encodeURIComponent(userKey)}`, JSON.stringify(detail)); } catch (_) {}
};

/** IndexedDB, rather than a realm-local promise, owns metadata updates. */
const updateSyncMeta = async (
  userKey: string, update: (current: SyncMeta) => SyncMeta
): Promise<SyncMeta> => {
  const db = await getDB();
  if (!db) throw new DurableStorageError('Sync metadata needs atomic storage. Captured changes remain on this device.');
  const tx = db.transaction(accountTransactionStores(db, [STORES.SYNC]), 'readwrite');
  try {
    const current = normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey));
    const next = update(structuredClone(current));
    retainResolvedConflicts(current, next);
    await putMeta(tx as StorageTransaction, userKey, next);
    await tx.done;
    publishCommit(userKey, next, []);
    return next;
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    try { await tx.done; } catch (_) {}
    throw error;
  }
};

export interface CommittedSnapshot {
  userKey: string;
  generation: number;
  values: Record<string, unknown>;
  meta: SyncMeta;
  pendingCount: number;
  walRevision: string;
  causal?: { generation: number; daySelection?: CounterDayAccountState['counterDaySelection'] };
}

export const storageService = {
  stageLocalValue(storeName: string, key: string, previousValue: unknown, nextValue: unknown, preserveSourceTime = false): string | null {
    if (!SYNCABLE_STORES.has(storeName)) return null;
    const now = new Date().toISOString();
    const storedValue = storeName === STORES.TRACKING
      ? (latestWalValue(storeName, key).found ? latestWalValue(storeName, key).value : readLocalCopy(storeName, key))
      : undefined;
    const durableNextValue = storeName === STORES.TRACKING
      ? mergeTrackingFocusSession(storedValue ?? previousValue, nextValue)
      : nextValue;
    const transaction = buildStagedLocalTransaction(
      storeName, key, previousValue, durableNextValue, nextWalOrder(), now, randomUuid, preserveSourceTime
    );
    if (!transaction) return null;
    transaction.captureProtocol = 'causal-compatible-v1';
    for (const change of transaction.changes) assertNewSyncPayload(change.payload);
    if (storeName === STORES.TRACKING && isRecord(previousValue) && isRecord(nextValue)
      && !jsonEqual(previousValue.focusSession, nextValue.focusSession)) {
      const session = normalizeFocusSession(previousValue.focusSession);
      transaction.admission = { kind: 'focus-transition', sessionId: session?.sessionId ?? null, taskId: session?.taskId ?? null };
    }
    const serialized = JSON.stringify(transaction);
    if (serialized === undefined) throw new DurableStorageError();
    captureWal(key, walKey(transaction), serialized);
    window.dispatchEvent(new CustomEvent('goalflow:captured', { detail: { userKey: key, actionId: transaction.id } }));
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
        change.storeName === STORES.TRACKING
          ? mergeTrackingFocusSession(
            (latestWalValue(change.storeName, key).found
              ? latestWalValue(change.storeName, key).value
              : readLocalCopy(change.storeName, key)) ?? change.previousValue,
            change.nextValue
          )
          : change.nextValue,
        baseOrder + index,
        now,
        randomUuid
      );
      if (transaction) {
        transaction.captureProtocol = 'causal-compatible-v1';
        for (const entityChange of transaction.changes) assertNewSyncPayload(entityChange.payload);
        transactions.push(transaction);
      }
    }
    if (!transactions.length) return null;
    const id = randomUuid();
    const group: StagedLocalTransactionGroup = { schemaVersion: 1, admissionVersion: 1, userKey: key, transactions };
    const serialized = JSON.stringify(group);
    if (serialized === undefined) throw new DurableStorageError();
    captureWal(key, `${walPrefixForUser(key)}batch-${id}`, serialized);
    window.dispatchEvent(new CustomEvent('goalflow:captured', { detail: { userKey: key, actionId: id } }));
    return id;
  },

  async retryAtomicStorage(): Promise<void> {
    if (useFallbackStorage) { useFallbackStorage = false; dbPromise = null; }
    if (!await getDB()) throw new DurableStorageError('IndexedDB is still unavailable. Captured actions remain preserved.');
  },

  async readCommittedSnapshot(userKey: string): Promise<CommittedSnapshot> {
    const db = await getDB();
    if (!db) throw new DurableStorageError('Committed local state cannot be verified while IndexedDB is unavailable.');
    const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readonly');
    const meta = normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey));
    const causal = db.objectStoreNames.contains(CAUSAL_STORE)
      ? await readCausalAccount(tx, userKey) as (CounterDayAccountState & FocusAccountState & { completionOutbox?: Record<string, unknown> }) | undefined : undefined;
    const committed: Record<string, unknown> = {};
    for (const storeName of DATA_STORES) committed[storeName] = await readAccountValue(tx, storeName, userKey);
    await tx.done;
    const captured = listWal(userKey);
    const pending = freshWal(meta, captured);
    const values = overlayPendingValues(committed, compatibleOverlay(pending, db.objectStoreNames.contains(CAUSAL_STORE)));
    for (const storeName of [STORES.TRACKING, STORES.PROGRESS, STORES.SETTINGS, STORES.STATS, STORES.ACCOUNTABILITY, STORES.CIRCADIAN]) {
      const value = values[storeName];
      if ((value !== undefined && !isRecord(value))
        || (value === undefined && meta.versions[`${storeName}:singleton`])) {
        throw new DurableStorageError(`The committed ${storeName} projection cannot be rendered safely. Its data and history remain preserved.`);
      }
    }
    const causalPending = causal ? [causal.focusOutbox, causal.counterOutbox, causal.counterDayOutbox, causal.completionOutbox]
      .reduce((count, outbox) => count + Object.keys(outbox ?? {}).length, 0) : 0;
    return { userKey, generation: Math.max(meta.localState?.generation ?? 0, causal?.generation ?? 0), values, meta,
      ...(causal ? { causal: { generation: causal.generation, daySelection: causal.counterDaySelection } } : {}),
      pendingCount: causalPending + pending.length + Object.keys(meta.localState?.blocked ?? {}).length + [...DATA_STORES, STORES.SYNC].filter(store => { const raw = window.localStorage.getItem(fallbackKey(store, userKey)); return raw !== null && !meta.localState?.fallbackCopies?.[store]?.includes(raw); }).length, walRevision: stableJson(captured) };
  },

  async admitFocusControl(userKey: string, input: Omit<LocalFocusControl, 'actorId'>) {
    const control: LocalFocusControl = { ...structuredClone(input), actorId: readDeviceId() };
    const name = activeDatabaseName();
    if (control.accountId !== userKey) throw new DurableStorageError('The focus control belongs to another account.');
    await storageService.flushPendingLocalChanges(userKey);
    const db = await getDB();
    if (!db || db.name !== name || !db.objectStoreNames.contains(CAUSAL_STORE)
      || !await db.get(CAUSAL_STORE, userKey)) throw new DurableStorageError('The focus control requires the prepared causal account.');
    const result = await admitLocalFocusControl(name, control);
    publishCommit(userKey, result.generation, [STORES.TRACKING], name);
    return result;
  },

  async admitReschedule(userKey: string, input: Omit<RescheduleIntent, 'actorId' | 'deviceId'>) {
    const deviceId = readDeviceId(), name = activeDatabaseName();
    const intent: RescheduleIntent = { ...structuredClone(input), actorId: deviceId, deviceId };
    if (intent.accountId !== userKey) throw new DurableStorageError('The reschedule belongs to another account.');
    await storageService.flushPendingLocalChanges(userKey);
    const db = await getDB();
    if (!db || db.name !== name || !db.objectStoreNames.contains(CAUSAL_STORE)
      || !await db.get(CAUSAL_STORE, userKey)) throw new DurableStorageError('Rescheduling requires the prepared causal account.');
    const result = await admitLocalReschedule(name, intent);
    publishCommit(userKey, result.generation, [STORES.TASKS, STORES.TRACKING], name);
    return result;
  },

  async admitFocusCompletion(userKey: string, input: {
    focus: Omit<CompletionControlIntent['focus'], 'actorId'>; details: CompletionControlIntent['details'];
  }) {
    const captured = structuredClone(input), deviceId = readDeviceId(), name = activeDatabaseName();
    const control: CompletionControlIntent = { ...captured, focus: { ...captured.focus, actorId: deviceId }, deviceId };
    if (control.focus.accountId !== userKey) throw new DurableStorageError('The completion belongs to another account.');
    await storageService.flushPendingLocalChanges(userKey);
    const db = await getDB();
    if (!db || db.name !== name || !db.objectStoreNames.contains(CAUSAL_STORE)
      || !await db.get(CAUSAL_STORE, userKey)) throw new DurableStorageError('Completion requires the prepared causal account.');
    const result = await admitLocalCompletionControl(name, control);
    // This is a wake-up hint only; subscribers read the committed generation.
    // A post-commit read failure must not report the saved completion as failed.
    publishCommit(userKey, 0, [STORES.TRACKING, ...result.admission.members.map(member => member.entityType)], name);
    return result;
  },

  subscribeCommitted(userKey: string, receive: (snapshot: CommittedSnapshot) => void): () => void {
    let stopped = false;
    let active = false;
    let dirty = false;
    const refresh = async () => {
      dirty = true;
      if (active) return;
      active = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const snapshot = await this.readCommittedSnapshot(userKey);
          if (snapshot.walRevision !== stableJson(listWal(userKey))) dirty = true;
          if (!stopped && !dirty) receive(snapshot);
        }
      } catch (error) {
        if (!stopped) window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: {
          userKey, state: 'error', localFailure: true, message: error instanceof Error ? error.message : 'Local view could not be verified.'
        } }));
      } finally { active = false; }
    };
    const onCommit = (event: Event) => {
      const hint = (event as CustomEvent).detail;
      if (hint?.userKey === userKey && hint?.database === activeDatabaseName() && hint?.context === LOCAL_SYNC_CONTEXT) void refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key?.startsWith(walPrefixForUser(userKey))) void refresh();
      if (event.key === `goalflow_commit_v1_${encodeURIComponent(userKey)}`) {
        try {
          const hint = JSON.parse(event.newValue ?? 'null');
          if (hint?.userKey === userKey && hint?.context === LOCAL_SYNC_CONTEXT && hint?.database === activeDatabaseName()) void refresh();
        } catch (_) { /* An invalid hint cannot authorize state changes. */ }
      }
    };
    const onResume = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onPeer = (event: Event) => { if ((event as CustomEvent).detail?.userKey === userKey) void refresh(); };
    window.addEventListener('goalflow:captured', onPeer);
    window.addEventListener('goalflow:peer-hint', onPeer);
    window.addEventListener('goalflow:committed', onCommit);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    const interval = window.setInterval(onResume, 5_000);
    void refresh();
    return () => {
      stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('goalflow:captured', onPeer);
      window.removeEventListener('goalflow:peer-hint', onPeer);
      window.removeEventListener('goalflow:committed', onCommit);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  },

  async get<T>(storeName: string, key: string): Promise<T | undefined> {
    const db = await getDB();
    const stores = SYNCABLE_STORES.has(storeName) ? DATA_STORES : [storeName];
    if (db) {
      const tx = db.transaction(accountTransactionStores(db, [...new Set([...stores, STORES.SYNC])]), 'readonly');
      const meta = normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, key));
      const committed: Record<string, unknown> = {};
      for (const store of stores) committed[store] = store === STORES.SYNC ? meta : await readAccountValue(tx, store, key);
      await tx.done;
      return (SYNCABLE_STORES.has(storeName)
        ? overlayPendingValues(committed, compatibleOverlay(freshWal(meta, listWal(key)), db.objectStoreNames.contains(CAUSAL_STORE)))[storeName]
        : committed[storeName]) as T | undefined;
    }
    // Degraded reads never certify a generation or a cursor.
    const copies = Object.fromEntries(stores.map(store => [store, readLocalCopy(store, key)]));
    return overlayPendingValues(copies, listWal(key))[storeName] as T | undefined;
  },

  set<T>(storeName: string, key: string, value: T, source: 'local' | 'cloud' = 'local'): Promise<void> {
    if ([CAUSAL_STORE, CAUSAL_BUSINESS_STORE].includes(storeName)) return Promise.reject(new DurableStorageError('Private causal evidence requires its owning coordinator.'));
    if (storeName === STORES.SYNC) return queueMutation(() => updateSyncMeta(key, current => {
      if (normalizeSyncMeta(value).cursor > current.cursor) throw new DurableStorageError('Metadata alone cannot advance the inbound cursor.', 'CURSOR_REQUIRES_PROJECTION');
      return mergeRestoredSyncMeta(current, value);
    })).then(() => undefined);
    if (source === 'cloud' && import.meta.env.MODE !== 'test') return Promise.reject(new DurableStorageError('Raw seeds are restricted to isolated tests; use atomic inbound application.'));
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) {
        if (source === 'local') this.stageLocalValue(storeName, key, readLocalCopy(storeName, key), value);
        throw new DurableStorageError('Atomic local commit is unavailable. Captured intent remains recoverable.');
      }
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let meta: SyncMeta;
      let committedValue: unknown;
      let admitted: string | null = null;
      try {
        meta = normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, key));
        if (source === 'local') {
          meta = await materializeWal(tx, key, meta);
          const previous = await readAccountValue(tx, storeName, key);
          // Explicit initialization/import callers use this API. React effects
          // may only drain; they cannot submit a delayed collection here.
          admitted = this.stageLocalValue(storeName, key, previous, value);
          meta = await materializeWal(tx, key, meta);
        } else {
          // Raw seed/hydration writes carry a generation but never a mutation.
          await writeAccountValue(tx, storeName, key, value);
        }
        committedValue = await readAccountValue(tx, storeName, key);
        await putMeta(tx, key, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(key, meta);
      // Retained fallback is independent evidence, not an optional mirror.
      writeRecovery(storeName, key, committedValue);
      publishCommit(key, meta, [storeName]);
      if (source === 'local') announceLocalChange(storeName, key, undefined);
      if (admitted && meta.localState?.blocked?.[admitted]) throw new DurableStorageError(meta.localState.blocked[admitted], 'STALE_INTENT');
    });
  },

  async flushPendingLocalChanges(userKey: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      await recoverFallbackState(userKey);
      const pending = listWal(userKey);
      if (!pending.length) return normalizeSyncMeta(await this.get(STORES.SYNC, userKey));
      const db = await getDB();
      if (!db) throw new DurableStorageError('Local intent is captured; commit is paused until IndexedDB is available.');
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let meta: SyncMeta;
      try {
        meta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        await putMeta(tx, userKey, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, meta);
      publishCommit(userKey, meta, [...new Set(pending.map(entry => entry.transaction.storeName))]);
      for (const storeName of new Set(pending.map(entry => entry.transaction.storeName))) announceLocalChange(storeName, userKey, undefined);
      return meta;
    });
  },

  async preparePushBatch(userKey: string, limit = 50): Promise<SyncMutation[]> {
    await this.flushPendingLocalChanges(userKey);
    return queueMutation(async () => {
      let batch: SyncMutation[] = [];
      const attemptedAt = new Date().toISOString();
      await updateSyncMeta(userKey, meta => {
        batch = transportablePushBatch(readyOutbox(meta, limit));
        return markMutationsAttempted(meta, batch.map(item => item.mutationId), attemptedAt);
      });
      return batch;
    });
  },

  async commitPushResults(userKey: string, batch: SyncMutation[], results: PushResult[]): Promise<SyncMeta> {
    return queueMutation(async () => {
      return updateSyncMeta(userKey, current => {
        const next = transitionPushResults(current, batch, results, new Date().toISOString());
        for (const result of results) {
          const request = batch.find(item => item.mutationId === result.mutationId);
          if (request && result.accepted && !localEvidence(next).receipts[result.mutationId]) localEvidence(next).receipts[result.mutationId] = { request, result };
        }
        return next;
      });
    });
  },

  async applyRemotePage(
    userKey: string,
    records: RemoteSyncRecord[],
    nextCursor: number,
    ownDeviceId: string
  ): Promise<{ meta: SyncMeta; changedStores: string[] }> {
    return queueMutation(async () => {
      await recoverFallbackState(userKey);
      const db = await getDB();
      if (!db) throw new DurableStorageError('Incoming sync is paused because IndexedDB cannot atomically install records and cursor. Local intents remain preserved.');
      const entityStores = Array.from(new Set(records.map(record => record.entityType)));
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let transition: ReturnType<typeof transitionRemotePage>;
      try {
        const currentMeta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        const currentValues: Record<string, unknown> = {};
        for (const storeName of entityStores) currentValues[storeName] = await readAccountValue(tx, storeName, userKey);
        transition = transitionRemotePage(
          currentMeta, currentValues, records, nextCursor, ownDeviceId, new Date().toISOString()
        );
        for (const storeName of transition.changedStores) {
          const value = transition.values[storeName];
          await writeAccountValue(tx, storeName, userKey, value);
        }
        await putMeta(tx, userKey, transition.meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, transition.meta);
      publishCommit(userKey, transition.meta, DATA_STORES);
      for (const storeName of transition.changedStores) {
        const value = transition.values[storeName];
        if (value === undefined) safeLocalStorageRemove(recoveryKey(storeName, userKey));
        else writeRecovery(storeName, userKey, value);
        announceCloudChange(userKey, storeName, value);
      }
      return { meta: transition.meta, changedStores: transition.changedStores };
    });
  },

  async markSyncSuccessful(userKey: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      return updateSyncMeta(userKey, current => ({ ...current, lastSuccessfulSync: new Date().toISOString() }));
    });
  },

  async mergeServerConflicts(userKey: string, conflicts: RemoteServerConflict[]): Promise<SyncMeta> {
    return queueMutation(async () => {
      return updateSyncMeta(userKey, current => transitionServerConflicts(current, conflicts));
    });
  },

  async commitAutomaticReconciliation(userKey: string, candidate: ReconciliationCandidate, reply: unknown): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('Automatic sync needs durable storage. Your changes remain saved.');
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let transition: ReturnType<typeof applyAutomaticReconciliation>;
      try {

        const meta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        transition = applyAutomaticReconciliation(meta, await readAccountValue(tx, candidate.entityType, userKey), candidate, reply);
        retainResolvedConflicts(meta, transition.meta);
        localEvidence(transition.meta).reconciliations ??= {};
        localEvidence(transition.meta).reconciliations![stableJson(candidate)] = { candidate, reply };
        if (transition.changed) {
          await writeAccountValue(tx, candidate.entityType, userKey, transition.value);
        }
        await putMeta(tx, userKey, transition.meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, transition.meta);
      publishCommit(userKey, transition.meta, DATA_STORES);
      if (transition.changed) {
        if (transition.value === undefined) safeLocalStorageRemove(recoveryKey(candidate.entityType, userKey));
        else writeRecovery(candidate.entityType, userKey, transition.value);
        announceCloudChange(userKey, candidate.entityType, transition.value);
      }
      return transition.meta;
    });
  },

  async getConflict(userKey: string, conflictId: string): Promise<LocalConflict | undefined> {
    const meta = normalizeSyncMeta(await this.get(STORES.SYNC, userKey));
    return meta.conflicts.find(item => item.id === conflictId);
  },

  async resolveConflictLocally(userKey: string, conflictId: string): Promise<SyncMeta> {
    return queueMutation(async () => {
      return updateSyncMeta(userKey, current => resolveConflictWithLocal(current, conflictId, readDeviceId(), new Date().toISOString(), randomUuid()));
    });
  },

  async resolveConflictWithCloud(userKey: string, conflictId: string, expected?: LocalConflict): Promise<SyncMeta> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('The cloud version cannot be applied atomically while IndexedDB is unavailable.');
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let currentMeta: SyncMeta;
      let conflict: LocalConflict | undefined;
      let nextValue: unknown;
      try {
        currentMeta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        conflict = currentMeta.conflicts.find(item => item.id === conflictId);
        if (!conflict) {
          // Materialization may have installed unrelated WAL even when this
          // conflict was already resolved by a peer. Commit its journal too.
          await putMeta(tx, userKey, currentMeta);
          await tx.done;
          retireMaterializedWal(userKey, currentMeta);
          publishCommit(userKey, currentMeta, DATA_STORES);
          return currentMeta;
        }
        if (expected && !jsonEqual(expected, conflict)) throw new DurableStorageError('The conflict changed while the response was in flight. New intent remains preserved.');
        const currentValue = await readAccountValue(tx, conflict.entityType, userKey);
        nextValue = applyConflictCloudValue(currentValue, conflict);
        await writeAccountValue(tx, conflict.entityType, userKey, nextValue);
        const beforeResolution = structuredClone(currentMeta);
        currentMeta.conflicts = currentMeta.conflicts.filter(item => item.id !== conflictId);
        retainResolvedConflicts(beforeResolution, currentMeta);
        await putMeta(tx, userKey, currentMeta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, currentMeta);
      publishCommit(userKey, currentMeta, [conflict.entityType]);
      if (nextValue === undefined) safeLocalStorageRemove(recoveryKey(conflict.entityType, userKey));
      else writeRecovery(conflict.entityType, userKey, nextValue);
      announceCloudChange(userKey, conflict.entityType, nextValue);
      return currentMeta;
    });
  },

  async delete(storeName: string, key: string): Promise<void> {
    if ([STORES.SYNC, CAUSAL_STORE, CAUSAL_BUSINESS_STORE].includes(storeName)) throw new DurableStorageError('Sync evidence cannot be deleted through a record API.');
    if (SYNCABLE_STORES.has(storeName)) return this.set(storeName, key, undefined);
    await queueMutation(async () => {
      const db = await getDB();
      if (db) await db.delete(storeName, key);
      else verifiedLocalStorageWrite(deletedKey(storeName, key), '1');
      safeLocalStorageRemove(recoveryKey(storeName, key));
      safeLocalStorageRemove(fallbackKey(storeName, key));
    });
  },

  async clear(storeName: string): Promise<void> {
    if ([STORES.SYNC, CAUSAL_STORE, CAUSAL_BUSINESS_STORE].includes(storeName) || SYNCABLE_STORES.has(storeName)) throw new DurableStorageError('Account data cannot be cleared without an audited account-scoped operation.');
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

  /** An explicit local-day boundary, evaluated against the latest projection. */
  async rolloverTrackingDay(userKey: string, today: string): Promise<unknown> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('The day boundary awaits atomic storage.');
      if (db.objectStoreNames.contains(CAUSAL_STORE)) {
        const state = await db.get(CAUSAL_STORE, userKey) as CounterDayAccountState | undefined;
        if (!state?.trackingPresent || !isRecord(state.trackingValue)) throw new DurableStorageError('The causal day requires account initialization.');
        if (state.trackingValue.date !== today && state.counterDaySelection?.requestedDay !== today) {
          await admitLocalCounterDay(db.name, { schemaVersion: 1, actionId: randomUuid(), accountId: userKey,
            actorId: readDeviceId(), kind: 'select', day: today, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            capturedAt: new Date().toISOString() });
        }
        const snapshot = await storageService.readCommittedSnapshot(userKey);
        publishCommit(userKey, snapshot.meta, [STORES.TRACKING]);
        return snapshot.values[STORES.TRACKING];
      }
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let meta: SyncMeta;
      let next: unknown;
      try {
        meta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        const current = await readAccountValue(tx, STORES.TRACKING, userKey);
        if (!isRecord(current)
          || !isDailyTrackingValue({ date: current.date, planViewCount: current.planViewCount, dailyPostponeCount: current.dailyPostponeCount })
          || !isDailyTrackingValue({ date: today, planViewCount: 0, dailyPostponeCount: 0 })
          || (current.focusSession != null && !normalizeFocusSession(current.focusSession))) throw new DurableStorageError('The day boundary has an invalid tracking baseline.');
        next = current.date === today ? current : { ...current, date: today, planViewCount: 0, dailyPostponeCount: 0 };
        const action = buildStagedLocalTransaction(STORES.TRACKING, userKey, current, next, nextWalOrder(), new Date().toISOString(), randomUuid);
        if (action) {
          meta = appendStagedTransactions(meta, [action], readDeviceId());
          localEvidence(meta).journal[action.id] = action;
          localEvidence(meta).migrations ??= {};
          localEvidence(meta).migrations![`web-day-boundary-v1:${current.date}:${today}:${action.id}`] = action.id;
          await writeAccountValue(tx, STORES.TRACKING, userKey, next);
        }
        await putMeta(tx, userKey, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, meta);
      publishCommit(userKey, meta, DATA_STORES);
      return next;
    });
  },

  /** Initial cloud seeding reads both ownership and projection in one transaction. */
  async seedUnsynchronizedLocalData(userKey: string): Promise<void> {
    await this.flushPendingLocalChanges(userKey);
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('Cloud seeding awaits atomic storage.');
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let meta: SyncMeta;
      try {
        meta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        for (const storeName of DATA_STORES) {
          if (storeName === STORES.TRACKING && tx.objectStoreNames.contains(CAUSAL_STORE)) continue;
          if (Object.keys(meta.versions).some(key => key === storeName || key.startsWith(`${storeName}:`))
            || meta.outbox.some(item => item.entityType === storeName)
            || meta.conflicts.some(item => item.entityType === storeName)) continue;
          const value = await readAccountValue(tx, storeName, userKey);
          if (value === undefined) continue;
          const action = buildStagedLocalTransaction(storeName, userKey, undefined, value, nextWalOrder(), new Date().toISOString(), randomUuid, true);
          if (action) {
            meta = appendStagedTransactions(meta, [action], readDeviceId());
            localEvidence(meta).journal[action.id] = action;
          }
        }
        await putMeta(tx, userKey, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, meta);
      publishCommit(userKey, meta, DATA_STORES);
    });
  },

  async migrateCollectionV1<T>(userKey: string, storeName: string, migrationId: string, transform: (value: T) => T): Promise<T> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('Migration awaits atomic storage.');
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let meta: SyncMeta;
      let value: T;
      try {
        meta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        const evidence = localEvidence(meta);
        evidence.migrations ??= {};
        const current = await readAccountValue(tx, storeName, userKey) as T;
        value = current;
        if (!Object.prototype.hasOwnProperty.call(evidence.migrations, migrationId)) {
          value = transform(current);
          const action = buildStagedLocalTransaction(storeName, userKey, current, value, nextWalOrder(), new Date().toISOString(), randomUuid);
          if (action) {
            meta = appendStagedTransactions(meta, [action], readDeviceId());
            localEvidence(meta).journal[action.id] = action;
          }
          localEvidence(meta).migrations![migrationId] = action?.id ?? null;
          await writeAccountValue(tx, storeName, userKey, value);
        }
        await putMeta(tx, userKey, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, meta);
      publishCommit(userKey, meta, [storeName]);
      return value;
    });
  },

  async initializeIfAbsent<T>(storeName: string, userKey: string, value: T, migrate = false): Promise<T> {
    return queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('Initialization awaits atomic storage; existing data was not replaced.');
      const tx = db.transaction(accountTransactionStores(db, [...DATA_STORES, STORES.SYNC]), 'readwrite');
      let meta: SyncMeta;
      let installed: T;
      try {
        meta = await materializeWal(tx, userKey, normalizeSyncMeta(await readAccountValue(tx, STORES.SYNC, userKey)));
        const existing = await readAccountValue(tx, storeName, userKey);
        installed = existing === undefined ? value : existing as T;
        if (existing === undefined) {
          if (tx.objectStoreNames.contains(CAUSAL_BUSINESS_STORE) && (CAUSAL_BUSINESS_STORES as readonly string[]).includes(storeName)
            && await tx.objectStore(CAUSAL_BUSINESS_STORE).getKey([storeName, userKey]) !== undefined) {
            throw new DurableStorageError('Recorded absence or an undefined authoritative value requires explicit recovery before initialization.');
          }
          if (migrate) {
            const action = buildStagedLocalTransaction(storeName, userKey, undefined, value, nextWalOrder(), new Date().toISOString(), randomUuid);
            if (action) {
              meta = appendStagedTransactions(meta, [action], readDeviceId());
              localEvidence(meta).journal[action.id] = action;
            }
          }
          await writeAccountValue(tx, storeName, userKey, value);
        }
        await putMeta(tx, userKey, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, meta);
      publishCommit(userKey, meta, [storeName]);
      return installed;
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
          return await this.initializeIfAbsent(storeName, key, parsed, true);
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
    return this.initializeIfAbsent(storeName, key, defaultValue);
  },

  async migrateUserKey(sourceKey: string, targetKey: string): Promise<void> {
    if (!sourceKey || sourceKey === targetKey) return;
    if ((await getDB())?.objectStoreNames.contains(CAUSAL_STORE)) throw new DurableStorageError('Causal account identities require explicit recovery and cannot be rebound by a legacy key migration.');
    for (const storeName of DATA_STORES) {
      const targetValue = await this.get(storeName, targetKey);
      if (targetValue !== undefined) continue;
      const sourceValue = await this.get(storeName, sourceKey);
      if (sourceValue !== undefined) await this.initializeIfAbsent(storeName, targetKey, sourceValue, true);
    }
  },

  async exportBackup(userKey: string): Promise<GoalflowBackup> {
    const initialDb = await getDB();
    // Old captures cannot be replayed through the fenced tracking key model.
    // Export them verbatim instead; exporting is not recovery/admission.
    if (!initialDb?.objectStoreNames.contains(CAUSAL_STORE)) await this.flushPendingLocalChanges(userKey);
    return queueMutation(async () => {
      const collections: Record<string, unknown> = {};
      let schemaVersion = 4;
      const db = await getDB();
      if (db) {
        const causal = db.objectStoreNames.contains(CAUSAL_STORE);
        const businessFenced = db.objectStoreNames.contains(CAUSAL_BUSINESS_STORE);
        const tx = db.transaction(causalBusinessTransactionStores(db, [...DATA_STORES, STORES.SYNC, ...(causal ? [CAUSAL_STORE] : [])]), 'readonly');
        const authority = causal ? await readCausalAccount(tx, userKey) : undefined;
        for (const storeName of DATA_STORES) {
          const value = storeName === STORES.TRACKING
            ? (causal ? (authority?.trackingPresent ? authority.trackingValue : undefined) : await tx.objectStore(storeName).get(userKey))
            : await readCausalBusiness(tx, storeName, userKey);
          if (value !== undefined) collections[storeName] = value;
        }
        const meta = await readCausalBusiness(tx, STORES.SYNC, userKey);
        const trackingMirror = causal ? await tx.objectStore(STORES.TRACKING).get(userKey) : undefined;
        const business = businessFenced ? await readCausalBusinessBackup(tx, userKey) : undefined;
        if (meta !== undefined) collections[STORES.SYNC] = normalizeSyncMeta(meta);
        await tx.done;
        if (causal) {
          const captures = backupLocalCaptures(userKey);
          collections[CAUSAL_STORE] = { schemaVersion: 1, encoded: encodeCausalBackup({ authority, trackingMirror, sync: meta, captures,
            ...(business ? { business } : {}) }) };
          schemaVersion = business ? 6 : 5;
        }
      } else {
        for (const storeName of [...DATA_STORES, STORES.SYNC]) {
          const value = readLocalCopy(storeName, userKey);
          if (value !== undefined) collections[storeName] = value;
        }
      }
      return {
        schemaVersion,
        exportedAt: new Date().toISOString(),
        ownerKey: userKey,
        checksum: await checksumCollections(collections),
        collections
      };
    });
  },

  async importBackup(userKey: string, backup: Record<string, any>, mode: 'merge' | 'replace' = 'merge'): Promise<void> {
    backup = structuredClone(backup);
    const envelope = backup as Partial<GoalflowBackup>;
    const verifiedCollections = validateBackupCollections(backup);
    if (Number(envelope.schemaVersion) >= 4 && envelope.ownerKey !== userKey) {
      throw new Error('This backup belongs to a different Tsurfing account. Existing data is unchanged.');
    }
    if (envelope.checksum && await checksumCollections(verifiedCollections) !== envelope.checksum.toLowerCase()) {
      throw new Error('Backup checksum validation failed. The file may be incomplete or modified.');
    }
    if (Object.hasOwn(verifiedCollections, CAUSAL_STORE)) {
      if (![5, 6].includes(envelope.schemaVersion!) || envelope.ownerKey !== userKey || !envelope.checksum) throw new DurableStorageError('A bound schema-5 or schema-6 causal backup is required.');
      const evidence = readCausalBackup(userKey, verifiedCollections[CAUSAL_STORE], verifiedCollections, envelope.schemaVersion === 6);
      await validateCompletionApplicationEvidence(userKey, evidence.authority);
      if (stableJson(verifiedCollections[STORES.TRACKING]) !== stableJson(evidence.authority.trackingPresent ? evidence.authority.trackingValue : undefined)
        || stableJson(verifiedCollections[STORES.SYNC]) !== stableJson(evidence.sync === undefined ? undefined : normalizeSyncMeta(evidence.sync))) {
        throw new DurableStorageError('The causal backup projections differ from their retained evidence. Nothing was restored.');
      }
      return queueMutation(async () => {
        const initial = await getDB();
        if (!initial) throw new DurableStorageError('Causal restore requires IndexedDB. Existing data is unchanged.');
        const assertEmpty = async (tx: IDBPTransaction<unknown, string[], 'readonly' | 'readwrite'>) => {
          if (Array.from(tx.objectStoreNames).includes(CAUSAL_STORE)) {
            const existing = await tx.objectStore(CAUSAL_STORE).get(userKey);
            const restored = existing?.restoredBackups?.[envelope.checksum!];
            if (restored !== undefined) {
              if (stableJson(restored) !== stableJson(backup)) throw new DurableStorageError('The retained backup identity differs. Nothing was restored.');
              return true;
            }
          }
          for (const store of tx.objectStoreNames) {
            if (store === CAUSAL_BUSINESS_STORE) {
              for (const name of CAUSAL_BUSINESS_STORES) {
                if (await tx.objectStore(store).getKey([name, userKey]) !== undefined) throw new DurableStorageError('Existing business authority requires journal reconciliation before restore. Existing data is unchanged.');
              }
              continue;
            }
            if (await tx.objectStore(store).getKey(userKey) !== undefined) throw new DurableStorageError('Causal backup recovery requires journal reconciliation before restore into an existing account. Existing data is unchanged.');
          }
          if (Object.keys(backupLocalCaptures(userKey)).length) throw new DurableStorageError('Existing local captures require journal reconciliation before restore. They remain unchanged.');
          return false;
        };
        const before = initial.transaction(causalBusinessTransactionStores(initial, [...DATA_STORES, STORES.SYNC, ...(initial.objectStoreNames.contains(CAUSAL_STORE) ? [CAUSAL_STORE] : [])]), 'readonly');
        const duplicate = await assertEmpty(before);
        await before.done;
        if (duplicate) return;
        let db = await fenceLegacyTracking(initial.name);
        if (evidence.business) { const name = db.name; db.close(); db = await fenceLegacyBusinessStores(name); }
        try {
          const tx = db.transaction(causalBusinessTransactionStores(db, [...DATA_STORES, STORES.SYNC, CAUSAL_STORE]), 'readwrite');
          void tx.done.catch(() => undefined);
          try {
            // Recheck inside the write transaction: a peer may have committed
            // after the read-only preflight or during versionchange.
            if (await assertEmpty(tx)) { await tx.done; return; }
            const authority = structuredClone(evidence.authority);
            // Archive the complete imported artifact, including unknown stores,
            // mirror discrepancies and captures. Never turn captures into new
            // operations or materialize them under their old WAL keys.
            const archived = authority.restoredBackups ?? {};
            if (!isRecord(archived) || Object.hasOwn(archived, envelope.checksum!)) throw new DurableStorageError('The backup recovery archive needs explicit reconciliation.');
            authority.restoredBackups = { ...archived, [envelope.checksum!]: backup };
            for (const store of DATA_STORES) {
              if (store === STORES.TRACKING) {
                if (authority.trackingPresent) await tx.objectStore(store).add({ [TRACKING_KEY_PATH]: userKey, payload: authority.trackingValue });
              } else if (!evidence.business && Object.hasOwn(verifiedCollections, store)) {
                await writeCausalBusiness(tx, store, userKey, verifiedCollections[store]);
              }
            }
            if (evidence.business) {
              for (const store of CAUSAL_BUSINESS_STORES) {
                const record = evidence.business.records[store];
                if (record === undefined) continue;
                await tx.objectStore(CAUSAL_BUSINESS_STORE).add(record);
                if (record.present) await tx.objectStore(store).add({ [BUSINESS_KEY_PATH]: userKey, payload: record.value });
              }
            } else if (evidence.sync !== undefined) await writeCausalBusiness(tx, STORES.SYNC, userKey, evidence.sync);
            await tx.objectStore(CAUSAL_STORE).add(authority);
            await tx.done;
          } catch (error) {
            try { tx.abort(); } catch (_) {}
            try { await tx.done; } catch (_) {}
            throw error;
          }
        } finally { db.close(); }
      });
    }
    if ((await getDB())?.objectStoreNames.contains(CAUSAL_STORE)) {
      throw new DurableStorageError('Causal backup recovery requires journal reconciliation before restore. The backup and existing data remain unchanged.');
    }
    const collections = normalizeBackupCollectionsForWeb(verifiedCollections);
    await this.flushPendingLocalChanges(userKey);
    await this.createLocalSnapshot(userKey, 'before-restore');
    await queueMutation(async () => {
      const db = await getDB();
      if (!db) throw new DurableStorageError('Restore was not started because IndexedDB is unavailable. Existing data is unchanged.');
      const tx = db.transaction([...DATA_STORES, STORES.SYNC], 'readwrite');
      let meta: SyncMeta;
      const nextValues = new Map<string, unknown>();
      try {
        const syncStore = tx.objectStore(STORES.SYNC);
        meta = mergeRestoredSyncMeta(await materializeWal(tx, userKey, normalizeSyncMeta(await syncStore.get(userKey))), collections[STORES.SYNC]);
        const staged: StagedLocalTransaction[] = [];
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
        for (const action of staged) localEvidence(meta).journal[action.id] = action;
        for (const [storeName, value] of nextValues) {
          if (value === undefined) await tx.objectStore(storeName).delete(userKey);
          else await tx.objectStore(storeName).put(value, userKey);
        }
        await putMeta(tx, userKey, meta);
        await tx.done;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        try { await tx.done; } catch (_) {}
        throw error;
      }
      retireMaterializedWal(userKey, meta);
      publishCommit(userKey, meta, DATA_STORES);
      for (const [storeName, value] of nextValues) {
        if (value === undefined) safeLocalStorageRemove(recoveryKey(storeName, userKey));
        else writeRecovery(storeName, userKey, value);
        announceCloudChange(userKey, storeName, value);
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
      if (Object.hasOwn(backup.collections, CAUSAL_STORE)) throw new DurableStorageError('Causal journal reconciliation is required before preparing a repair database. Export remains available; the active database is unchanged.');
      return await queueMutation(async () => {
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
          throw new DurableStorageError('A verified recovery copy was prepared, but automatic database replacement is paused because other tabs may still admit changes. The active database and all histories are preserved.');

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
