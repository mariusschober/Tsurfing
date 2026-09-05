import {
  authenticatedFetchForUser,
  SessionAccountMismatchError,
  supabase
} from './authService';
import { readResponseBodyWithLimit, ResponseTooLargeError } from './boundedResponse';
import { DurableStorageError, storageService, STORES } from './storage';
import {
  emptySyncMeta,
  normalizeSyncMeta,
  type PushResult,
  type RemoteServerConflict,
  type RemoteSyncRecord,
  type SyncMeta,
  type SyncMutation
} from './syncProtocol';

export type SyncState = 'saved-locally' | 'syncing' | 'synced' | 'offline' | 'error' | 'conflict';

const SYNCED_STORES: string[] = [
  STORES.TASKS, STORES.GOALS, STORES.HABITS, STORES.STATS, STORES.PROGRESS,
  STORES.HASHTAGS, STORES.ACCOUNTABILITY, STORES.TRUE_NORTH, STORES.AMALGAM,
  STORES.TRACKING, STORES.CIRCADIAN, STORES.SETTINGS, STORES.DAILY_PLANS,
  STORES.TASK_EVENTS
];

export interface CloudSyncDependencies {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  isOnline: () => boolean;
  now: () => Date;
  deviceId: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

interface CloudSyncOptions {
  seedLocalData?: boolean;
}

const persistentDeviceId = (): string => {
  const key = 'goalflow-device-id';
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  if (localStorage.getItem(key) !== created) throw new DurableStorageError('A stable sync device identity could not be persisted.');
  return created;
};

const defaultRuntimeDependencies = {
  isOnline: () => navigator.onLine,
  now: () => new Date(),
  deviceId: persistentDeviceId
};

const dependenciesForUser = (userKey: string, signal?: AbortSignal): CloudSyncDependencies => ({
  ...defaultRuntimeDependencies,
  fetch: (input, init) => authenticatedFetchForUser(userKey, input, init),
  signal
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRYABLE_STATUS = new Set([408, 425, 429]);
export const FOREGROUND_SYNC_INTERVAL_MS = 30_000;
export const SYNC_HEALTH_INTERVAL_MS = 30_000;

export const syncWakeupTopicForUser = (userId: string): string | null =>
  UUID_PATTERN.test(userId) ? `tsurfing:user:${userId.toLowerCase()}` : null;

type ConfiguredSupabaseClient = NonNullable<typeof supabase>;

/** Subscribe only to the immutable account's private, payload-free wake-up topic. */
export const subscribeToSyncWakeups = (
  client: ConfiguredSupabaseClient,
  userId: string,
  onWake: () => void
): (() => void) => {
  const topic = syncWakeupTopicForUser(userId);
  if (!topic) return () => undefined;
  const realtimeChannel = client
    .channel(topic, { config: { private: true } })
    .on('broadcast', { event: 'sync_wakeup' }, () => onWake())
    .subscribe(status => {
      // A successful initial join or rejoin is itself a catch-up hint. The
      // cursor pull remains authoritative even if every Broadcast was missed.
      if (status === 'SUBSCRIBED') onWake();
    });
  return () => {
    void client.removeChannel(realtimeChannel).catch(() => undefined);
  };
};

export class SyncHttpError extends Error {
  readonly permanent: boolean;

  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'SyncHttpError';
    this.permanent = status >= 400 && status < 500 && !RETRYABLE_STATUS.has(status);
  }
}

export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncProtocolError';
  }
}

export const isPermanentSyncFailure = (error: unknown): boolean =>
  (error instanceof SyncHttpError && error.permanent)
  || error instanceof SyncProtocolError
  || error instanceof ResponseTooLargeError
  || error instanceof DurableStorageError
  || error instanceof SessionAccountMismatchError;

const emit = (state: SyncState, meta: SyncMeta, message?: string): void => {
  window.dispatchEvent(new CustomEvent('goalflow:sync-state', {
    detail: {
      state,
      lastSuccessfulSync: meta.lastSuccessfulSync,
      conflictCount: meta.conflicts.length,
      message
    }
  }));
};

const parseJson = async <T>(response: Response, failureMessage: string): Promise<T> => {
  let body: unknown;
  try { body = await response.json(); } catch (_) {
    if (!response.ok) throw new SyncHttpError(failureMessage, response.status, 'invalid_error_response');
    throw new SyncProtocolError(failureMessage);
  }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new SyncHttpError(error?.message || failureMessage, response.status, error?.code || 'sync_http_error');
  }
  return body as T;
};

const isValidWireInstant = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));

const isValidRemoteWireRecord = (value: unknown): value is RemoteSyncRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.entityType === 'string' && record.entityType.length > 0
    && typeof record.entityId === 'string' && record.entityId.length > 0
    && Number.isSafeInteger(record.version) && Number(record.version) > 0
    && Number.isSafeInteger(record.serverVersion) && Number(record.serverVersion) > 0
    && typeof record.deviceId === 'string' && record.deviceId.length > 0
    && Object.prototype.hasOwnProperty.call(record, 'payload')
    && isValidWireInstant(record.updatedAt)
    && Object.prototype.hasOwnProperty.call(record, 'deletedAt')
    && (record.deletedAt === null || isValidWireInstant(record.deletedAt));
};

const defaultSleep = (delayMs: number): Promise<void> =>
  new Promise(resolve => globalThis.setTimeout(resolve, delayMs));

const retryableStatus = (status: number): boolean => status >= 500 || RETRYABLE_STATUS.has(status);
const responseWithoutBody = (status: number): boolean => status === 204 || status === 205 || status === 304;

/** Bounded, jittered retry for idempotent sync requests and mutation-ID pushes. */
export const fetchSyncWithRetry = async (
  input: RequestInfo | URL,
  init: RequestInit,
  dependencies: CloudSyncDependencies
): Promise<Response> => {
  const maximumAttempts = Math.max(1, Math.min(5, dependencies.maxAttempts ?? 3));
  const timeoutMs = Math.max(250, Math.min(120_000, dependencies.requestTimeoutMs ?? 15_000));
  const maximumResponseBytes = Math.max(
    1,
    Math.min(16 * 1024 * 1024, dependencies.maxResponseBytes ?? 16 * 1024 * 1024)
  );
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const parentSignals = [dependencies.signal, init.signal ?? undefined]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    const alreadyAborted = parentSignals.find(signal => signal.aborted);
    if (alreadyAborted) throw alreadyAborted.reason ?? new DOMException('Synchronization stopped.', 'AbortError');
    const controller = new AbortController();
    const abortFromParent = (event: Event) => controller.abort((event.target as AbortSignal).reason);
    parentSignals.forEach(signal => signal.addEventListener('abort', abortFromParent, { once: true }));
    const timeout = globalThis.setTimeout(
      () => controller.abort(new DOMException('Synchronization request timed out.', 'TimeoutError')),
      timeoutMs
    );
    try {
      const response = await dependencies.fetch(input, { ...init, signal: controller.signal });
      if (!retryableStatus(response.status) || attempt + 1 >= maximumAttempts) {
        const body = responseWithoutBody(response.status)
          ? null
          : await readResponseBodyWithLimit(response, maximumResponseBytes);
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
      await response.body?.cancel().catch(() => undefined);
      lastError = new SyncHttpError('Synchronization service is temporarily unavailable.', response.status, 'sync_retryable');
    } catch (error) {
      const abortedParent = parentSignals.find(signal => signal.aborted);
      if (abortedParent) throw abortedParent.reason ?? error;
      lastError = error;
      if (isPermanentSyncFailure(error)
        || attempt + 1 >= maximumAttempts
        || !dependencies.isOnline()) throw error;
    } finally {
      globalThis.clearTimeout(timeout);
      parentSignals.forEach(signal => signal.removeEventListener('abort', abortFromParent));
    }
    const exponential = Math.min(500 * (2 ** attempt), 5_000);
    const jitter = Math.floor(Math.max(0, Math.min(1, random())) * 250);
    await sleep(exponential + jitter);
  }
  throw lastError ?? new Error('Synchronization request failed.');
};

const wireMutation = (mutation: SyncMutation) => ({
  mutationId: mutation.mutationId,
  deviceId: mutation.deviceId,
  entityType: mutation.entityType,
  entityId: mutation.entityId,
  baseServerVersion: mutation.baseServerVersion,
  version: mutation.version,
  payload: mutation.payload,
  updatedAt: mutation.updatedAt,
  deletedAt: mutation.deletedAt,
  resolvesConflictId: mutation.resolvesConflictId && UUID_PATTERN.test(mutation.resolvesConflictId)
    ? mutation.resolvesConflictId
    : undefined
});

const seedUnsynchronizedLocalData = async (userKey: string): Promise<void> => {
  const meta = await storageService.flushPendingLocalChanges(userKey);
  for (const storeName of SYNCED_STORES) {
    const hasSyncState = Object.keys(meta.versions).some(key => key === storeName || key.startsWith(`${storeName}:`))
      || meta.outbox.some(item => item.entityType === storeName)
      || meta.conflicts.some(item => item.entityType === storeName);
    if (hasSyncState) continue;
    const value = await storageService.get(storeName, userKey);
    if (value === undefined) continue;
    storageService.stageLocalValue(storeName, userKey, undefined, value);
  }
  await storageService.flushPendingLocalChanges(userKey);
};

/** One crash-safe, retry-safe synchronization cycle. Exported for adversarial tests. */
export const synchronizeCloudOnce = async (
  userKey: string,
  dependencies: CloudSyncDependencies = dependenciesForUser(userKey),
  options: CloudSyncOptions = {}
): Promise<SyncMeta> => {
  if (options.seedLocalData !== false) await seedUnsynchronizedLocalData(userKey);
  let meta = normalizeSyncMeta(await storageService.get(STORES.SYNC, userKey));
  if (!dependencies.isOnline()) return meta;
  const ownDeviceId = dependencies.deviceId();

  while (true) {
    const batch = await storageService.preparePushBatch(userKey, 50);
    if (!batch.length) break;
    const response = await fetchSyncWithRetry('/api/v1/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutations: batch.map(wireMutation) })
    }, dependencies);
    const body = await parseJson<{ results?: PushResult[] }>(response, 'Sync push failed. Local changes remain pending.');
    if (!Array.isArray(body.results)) throw new SyncProtocolError('Sync push response was invalid. Local changes remain pending.');
    try {
      meta = await storageService.commitPushResults(userKey, batch, body.results);
    } catch (error) {
      throw new SyncProtocolError(error instanceof Error ? error.message : 'Sync receipts were invalid. Local changes remain pending.');
    }
  }

  let hasMore = true;
  while (hasMore) {
    meta = normalizeSyncMeta(await storageService.get(STORES.SYNC, userKey));
    const cursorBefore = meta.cursor;
    const response = await fetchSyncWithRetry(`/api/v1/sync/pull?cursor=${cursorBefore}&limit=100`, {}, dependencies);
    const body = await parseJson<{
      records?: RemoteSyncRecord[];
      nextCursor?: number;
      hasMore?: boolean;
    }>(response, 'Sync pull failed. The local cursor was not advanced.');
    if (!body || typeof body !== 'object'
      || !Array.isArray(body.records)
      || typeof body.nextCursor !== 'number'
      || !Number.isSafeInteger(body.nextCursor)
      || typeof body.hasMore !== 'boolean'
      || body.records.some(record => !isValidRemoteWireRecord(record))) {
      throw new SyncProtocolError('Sync pull response was invalid. The local cursor was not advanced.');
    }
    const nextCursor = body.nextCursor;
    if (nextCursor < cursorBefore || (body.hasMore && nextCursor === cursorBefore)) {
      throw new SyncProtocolError('Sync pull cursor did not advance safely.');
    }
    const highestRecord = body.records.reduce((highest, record) => Math.max(highest, Number(record.serverVersion) || 0), cursorBefore);
    if (nextCursor !== highestRecord) throw new SyncProtocolError('Sync pull cursor would skip or discard remote information.');
    const applied = await storageService.applyRemotePage(userKey, body.records, nextCursor, ownDeviceId);
    meta = applied.meta;
    hasMore = body.hasMore;
  }

  const conflictResponse = await fetchSyncWithRetry('/api/v1/sync/conflicts', {}, dependencies);
  const conflictBody = await parseJson<{ conflicts?: RemoteServerConflict[] }>(
    conflictResponse,
    'Sync conflicts could not be verified. Existing local state was not changed.'
  );
  if (!Array.isArray(conflictBody.conflicts)) {
    throw new SyncProtocolError('Sync conflict response was invalid. Existing local state was not changed.');
  }
  meta = await storageService.mergeServerConflicts(userKey, conflictBody.conflicts);

  meta = await storageService.markSyncSuccessful(userKey);
  return meta;
};

// P2-C: Mutex for sync serialization when navigator.locks unavailable or denies
class SimpleMutex {
  private locked = false;
  private queue: Array<() => void> = [];
  async acquire(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    await new Promise<void>(res => this.queue.push(res));
    this.locked = true;
  }
  release(): void {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}
const syncMutex = new SimpleMutex();

export const fetchSyncHealth = async (
  userKey: string,
  dependencies: CloudSyncDependencies = dependenciesForUser(userKey)
): Promise<{ serverRecordCount: number; unresolvedConflicts: number; serverVersion: number }> => {
  const response = await fetchSyncWithRetry('/api/v1/sync/health', {}, dependencies);
  const body = await parseJson<{ serverRecordCount?: number; unresolvedConflicts?: number; serverVersion?: number }>(response, 'Sync health unavailable');
  return {
    serverRecordCount: Number(body.serverRecordCount ?? 0),
    unresolvedConflicts: Number(body.unresolvedConflicts ?? 0),
    serverVersion: Number(body.serverVersion ?? 0)
  };
};

/** Keep the non-authoritative diagnostic probe out of bursty durable sync traffic. */
export const createPeriodicSyncHealthCheck = (
  check: () => Promise<unknown>,
  now: () => number = () => Date.now()
): (() => Promise<void>) => {
  let nextAllowedAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const observedAt = now();
    if (observedAt < nextAllowedAt) return;
    nextAllowedAt = observedAt + SYNC_HEALTH_INTERVAL_MS;
    await check().catch(() => undefined);
  };
};

/** Coalesces overlapping wake-ups without losing a request made during an active cycle. */
export const createCoalescedSyncRunner = (
  canRun: () => boolean,
  runOnce: () => Promise<void>
): (() => Promise<void>) => {
  let active: Promise<void> | null = null;
  let rerunRequested = false;

  const request = async (): Promise<void> => {
    if (!canRun()) return;
    if (active) {
      rerunRequested = true;
      return active;
    }
    active = (async () => {
      do {
        rerunRequested = false;
        await runOnce();
      } while (rerunRequested && canRun());
    })().finally(() => { active = null; });
    return active;
  };
  return request;
};

/** Completes a migration-style initializer once, while leaving failures retryable. */
export const createRetryableOneTimeInitializer = (
  initialize: () => Promise<void>
): (() => Promise<void>) => {
  let initialized = false;
  return async () => {
    if (initialized) return;
    await initialize();
    initialized = true;
  };
};

export const startCloudSync = (userKey: string): (() => void) => {
  if (!supabase) return () => undefined;
  let stopped = false;
  let blockedByPermanentError = false;
  let localChangeQueued = false;
  const lifecycleController = new AbortController();
  const lifecycleDependencies = dependenciesForUser(userKey, lifecycleController.signal);
  const checkHealth = createPeriodicSyncHealthCheck(
    () => fetchSyncHealth(userKey, lifecycleDependencies)
  );
  const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(`goalflow-sync:${userKey}`);
  const ensureLocalDataSeeded = createRetryableOneTimeInitializer(
    () => seedUnsynchronizedLocalData(userKey)
  );

  const synchronize = createCoalescedSyncRunner(
    () => !stopped && !blockedByPermanentError,
    async () => {
      try {
        const before = normalizeSyncMeta(await storageService.get(STORES.SYNC, userKey));
        if (!navigator.onLine) {
          emit('offline', before);
          return;
        }
        emit('syncing', before);
        const run = async () => {
          if (stopped) return;
          await ensureLocalDataSeeded();
          const meta = await synchronizeCloudOnce(userKey, lifecycleDependencies, { seedLocalData: false });
          const state: SyncState = meta.conflicts.length ? 'conflict' : 'synced';
          emit(state, meta);
          channel?.postMessage({
            type: 'complete', state, lastSuccessfulSync: meta.lastSuccessfulSync,
            conflictCount: meta.conflicts.length
          });
        };
        // ifAvailable false plus the in-page mutex serializes local writers.
        if ('locks' in navigator) {
          await navigator.locks.request(`goalflow-sync:${userKey}`, { ifAvailable: false }, async lock => {
            if (lock) {
              await syncMutex.acquire();
              try { await run(); await checkHealth(); } finally { syncMutex.release(); }
            }
          });
        } else {
          await syncMutex.acquire();
          try { await run(); await checkHealth(); } finally { syncMutex.release(); }
        }
      } catch (error) {
        if (stopped && (error instanceof DOMException || lifecycleController.signal.aborted)) return;
        if (isPermanentSyncFailure(error)) {
          blockedByPermanentError = true;
          if (error instanceof SyncHttpError && (error.status === 401 || error.status === 403)) {
            window.dispatchEvent(new CustomEvent('goalflow:session-rejected', {
              detail: { status: error.status, code: error.code }
            }));
          }
        }
        let meta: SyncMeta;
        try {
          meta = normalizeSyncMeta(await storageService.get(STORES.SYNC, userKey));
        } catch (_) {
          meta = emptySyncMeta();
        }
        emit(navigator.onLine ? 'error' : 'offline', meta, error instanceof Error ? error.message : 'Synchronization failed.');
      }
    }
  );

  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ storeName: string; key: string }>).detail;
    if (detail.key !== userKey || !SYNCED_STORES.includes(detail.storeName)) return;
    if (localChangeQueued) return;
    localChangeQueued = true;
    window.queueMicrotask(() => {
      localChangeQueued = false;
      void synchronize();
    });
  };
  const onOnline = () => void synchronize();
  const onRetry = () => { blockedByPermanentError = false; void synchronize(); };
  const onFocus = () => { if (document.visibilityState === 'visible') void synchronize(); };
  const onChannel = (event: MessageEvent) => {
    if (event.data?.type === 'complete') window.dispatchEvent(new CustomEvent('goalflow:sync-state', { detail: event.data }));
  };
  const stopRealtimeWakeups = subscribeToSyncWakeups(supabase, userKey, () => void synchronize());

  window.addEventListener('goalflow:local-change', onLocalChange);
  window.addEventListener('online', onOnline);
  window.addEventListener('goalflow:sync-retry', onRetry);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  channel?.addEventListener('message', onChannel);
  const interval = window.setInterval(() => {
    if (document.visibilityState === 'visible') void synchronize();
  }, FOREGROUND_SYNC_INTERVAL_MS);
  void synchronize();

  return () => {
    stopped = true;
    lifecycleController.abort(new DOMException('Synchronization stopped.', 'AbortError'));
    window.clearInterval(interval);
    window.removeEventListener('goalflow:local-change', onLocalChange);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('goalflow:sync-retry', onRetry);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    stopRealtimeWakeups();
    channel?.removeEventListener('message', onChannel);
    channel?.close();
  };
};

export const resolveLocalConflict = async (
  userKey: string,
  conflictId: string,
  choice: 'local' | 'cloud',
  dependencies: CloudSyncDependencies = dependenciesForUser(userKey)
): Promise<void> => {
  const conflict = await storageService.getConflict(userKey, conflictId);
  if (!conflict) return;
  if (choice === 'local') {
    const meta = await storageService.resolveConflictLocally(userKey, conflictId);
    emit('conflict', meta, 'The local version remains preserved until its retry is accepted.');
    window.dispatchEvent(new Event('online'));
    return;
  }
  if (UUID_PATTERN.test(conflict.id)) {
    if (!conflict.mutationId || !UUID_PATTERN.test(conflict.mutationId)) {
      throw new SyncProtocolError('The server conflict identity is invalid. Both versions remain preserved.');
    }
    const response = await fetchSyncWithRetry('/api/v1/sync/conflicts/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conflictId: conflict.id, mutationId: conflict.mutationId, choice: 'cloud' })
    }, dependencies);
    const acknowledgment = await parseJson<{
      resolved?: boolean;
      conflictId?: string;
      mutationId?: string;
    }>(response, 'The server conflict could not be resolved. Both versions remain preserved.');
    if (acknowledgment.resolved !== true
      || acknowledgment.conflictId !== conflict.id
      || acknowledgment.mutationId !== conflict.mutationId) {
      throw new SyncProtocolError('The server did not acknowledge the exact conflict. Both versions remain preserved.');
    }
  }
  const meta = await storageService.resolveConflictWithCloud(userKey, conflictId);
  emit(meta.conflicts.length ? 'conflict' : 'saved-locally', meta);
};
