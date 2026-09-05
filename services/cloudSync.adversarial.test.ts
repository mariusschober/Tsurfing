import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fetchSyncWithRetry,
  resolveLocalConflict,
  synchronizeCloudOnce,
  type CloudSyncDependencies
} from './cloudSync';
import { storageService, STORES } from './storage';
import { emptySyncMeta, normalizeSyncMeta } from './syncProtocol';

class TestLocalStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

interface ServerRecord {
  entityType: string;
  entityId: string;
  version: number;
  serverVersion: number;
  deviceId: string;
  payload: unknown;
  updatedAt: string;
  deletedAt: string | null;
}

class DurableFakeServer {
  readonly records: Map<string, ServerRecord>;
  readonly receipts: Map<string, { request: string; result: Record<string, unknown> }>;
  readonly conflicts: Array<Record<string, unknown>>;
  sequence: { value: number };
  failBeforeCommit = false;
  failAfterCommit = false;
  return401 = false;
  duplicateResults = false;

  constructor(state?: {
    records: Map<string, ServerRecord>;
    receipts: Map<string, { request: string; result: Record<string, unknown> }>;
    sequence: { value: number };
    conflicts?: Array<Record<string, unknown>>;
  }) {
    this.records = state?.records ?? new Map();
    this.receipts = state?.receipts ?? new Map();
    this.conflicts = state?.conflicts ?? [];
    this.sequence = state?.sequence ?? { value: 0 };
  }

  durableState() {
    return { records: this.records, receipts: this.receipts, sequence: this.sequence, conflicts: this.conflicts };
  }

  fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (this.return401) return new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 });
    if (path.endsWith('/sync/push')) {
      if (this.failBeforeCommit) {
        this.failBeforeCommit = false;
        throw new TypeError('network disconnected before commit');
      }
      const mutations = JSON.parse(String(init?.body)).mutations as Array<Record<string, unknown>>;
      const results = mutations.map(mutation => this.push(mutation));
      if (this.failAfterCommit) {
        this.failAfterCommit = false;
        throw new TypeError('response lost after commit');
      }
      const wireResults = this.duplicateResults && results.length ? [results[0], results[0], ...results.slice(1)] : results;
      return Response.json({ results: wireResults });
    }
    if (path.includes('/sync/pull')) {
      const cursor = Number(new URL(path, 'https://goalflow.test').searchParams.get('cursor') ?? 0);
      const records = Array.from(this.records.values())
        .filter(record => record.serverVersion > cursor)
        .sort((left, right) => left.serverVersion - right.serverVersion);
      return Response.json({
        records,
        nextCursor: records.at(-1)?.serverVersion ?? cursor,
        hasMore: false
      });
    }
    if (path.endsWith('/sync/conflicts')) return Response.json({ conflicts: this.conflicts });
    return new Response(null, { status: 404 });
  };

  private push(mutation: Record<string, unknown>): Record<string, unknown> {
    const mutationId = String(mutation.mutationId);
    const request = JSON.stringify(mutation);
    const receipt = this.receipts.get(mutationId);
    if (receipt) {
      if (receipt.request !== request) {
        return { mutationId, accepted: false, replayMismatch: true, serverVersion: 0 };
      }
      return { mutationId, ...receipt.result };
    }
    const key = `${mutation.entityType}:${mutation.entityId}`;
    const existing = this.records.get(key);
    const base = mutation.baseServerVersion === null ? null : Number(mutation.baseServerVersion);
    if ((existing && base !== existing.serverVersion) || (!existing && base !== null)) {
      const result = {
        accepted: false,
        conflictId: `00000000-0000-4000-8000-${String(++this.sequence.value).padStart(12, '0')}`,
        serverVersion: existing?.serverVersion ?? 0,
        record: existing
      };
      this.receipts.set(mutationId, { request, result });
      return { mutationId, ...result };
    }
    const serverVersion = ++this.sequence.value;
    const record: ServerRecord = {
      entityType: String(mutation.entityType),
      entityId: String(mutation.entityId),
      version: Number(mutation.version),
      serverVersion,
      deviceId: String(mutation.deviceId),
      payload: mutation.payload,
      updatedAt: String(mutation.updatedAt),
      deletedAt: mutation.deletedAt === null ? null : String(mutation.deletedAt)
    };
    this.records.set(key, record);
    const result = { accepted: true, serverVersion, record };
    this.receipts.set(mutationId, { request, result });
    return { mutationId, ...result };
  }
}

const installBrowser = () => {
  const localStorage = new TestLocalStorage();
  const events = new EventTarget();
  (globalThis as any).window = {
    localStorage,
    dispatchEvent: events.dispatchEvent.bind(events),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  };
  (globalThis as any).localStorage = localStorage;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { onLine: true }
  });
};

const dependencies = (server: DurableFakeServer, deviceId = 'device-a'): CloudSyncDependencies => ({
  fetch: server.fetch as CloudSyncDependencies['fetch'],
  isOnline: () => true,
  now: () => new Date('2026-08-27T00:00:00.000Z'),
  deviceId: () => deviceId,
  sleep: async () => undefined,
  random: () => 0
});

const task = (title: string, id = 'task-1', extra: Record<string, unknown> = {}) => ({
  id, title, scheduledFor: '2026-08-27', dateAssigned: '2026-08-27',
  schedulePrecision: 'day', createdAt: 1, updatedAt: 1, completed: false,
  lifecycleStatus: 'open', ...extra
});

describe('adversarial cloud synchronization', () => {
  beforeEach(() => installBrowser());

  it('automatically retries the exact mutation when the server commits but the response is lost', async () => {
    const key = `timeout-after-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('created offline')]);
    server.failAfterCommit = true;

    const meta = await synchronizeCloudOnce(key, dependencies(server));
    expect(meta.outbox).toHaveLength(0);
    expect(meta.conflicts).toHaveLength(0);
    expect(server.records.size).toBe(1);
    expect(server.receipts.size).toBe(1);
  });

  it('automatically retries the unchanged mutation after a timeout before commit', async () => {
    const key = `timeout-before-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('safe')]);
    server.failBeforeCommit = true;

    const meta = await synchronizeCloudOnce(key, dependencies(server));
    expect(meta.outbox).toHaveLength(0);
    expect(server.records.size).toBe(1);
  });

  it('bounds transient retries and leaves the outbox intact after exhaustion', async () => {
    const key = `retry-exhaustion-${crypto.randomUUID()}`;
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('still local')]);
    let calls = 0;
    const failedDependencies: CloudSyncDependencies = {
      ...dependencies(new DurableFakeServer()),
      maxAttempts: 3,
      fetch: async () => {
        calls += 1;
        throw new TypeError('network unavailable');
      }
    };

    await expect(synchronizeCloudOnce(key, failedDependencies)).rejects.toThrow('network unavailable');
    expect(calls).toBe(3);
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).outbox).toHaveLength(1);
  });

  it('aborts an in-flight logout without acknowledging or deleting the local mutation', async () => {
    const key = `logout-during-sync-${crypto.randomUUID()}`;
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('survives logout')]);
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      markStarted?.();
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as CloudSyncDependencies['fetch'];
    const sync = synchronizeCloudOnce(key, {
      ...dependencies(new DurableFakeServer()),
      fetch,
      maxAttempts: 1,
      signal: controller.signal
    });
    const rejection = expect(sync).rejects.toMatchObject({ name: 'AbortError' });

    await started;
    controller.abort(new DOMException('signed out', 'AbortError'));
    await rejection;

    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).outbox).toHaveLength(1);
  });

  it('never retries a permanent authorization response', async () => {
    let calls = 0;
    const permanentDependencies: CloudSyncDependencies = {
      ...dependencies(new DurableFakeServer()),
      fetch: async () => {
        calls += 1;
        return Response.json({ error: { code: 'session_revoked', message: 'revoked' } }, { status: 401 });
      }
    };

    const response = await fetchSyncWithRetry('/api/v1/sync/pull', {}, permanentDependencies);
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('keeps every mutation pending across 401 and later authentication recovery', async () => {
    const key = `auth-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('auth-safe')]);
    server.return401 = true;

    await expect(synchronizeCloudOnce(key, dependencies(server))).rejects.toThrow('expired');
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).outbox).toHaveLength(1);
    expect(server.records.size).toBe(0);

    server.return401 = false;
    expect((await synchronizeCloudOnce(key, dependencies(server))).outbox).toHaveLength(0);
  });

  it('persists a native task event in IndexedDB before advancing the web cursor', async () => {
    const key = `native-event-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const event = {
      id: 'event-1', taskId: 'task-1', eventType: 'completed', localDate: '2026-08-27',
      metadata: true, createdAt: 1_777_776_000_000
    };
    server.records.set('task_events:event-1', {
      entityType: 'task_events', entityId: 'event-1', version: 1, serverVersion: 1,
      deviceId: 'native-device', payload: event, updatedAt: '2026-08-27T00:00:00.000Z', deletedAt: null
    });
    server.sequence.value = 1;

    const meta = await synchronizeCloudOnce(key, dependencies(server, 'web-device'));

    expect(meta.cursor).toBe(1);
    expect(await storageService.get(STORES.TASK_EVENTS, key)).toEqual([event]);
  });

  it('rejects a pull record without its durable timestamp before advancing the cursor', async () => {
    const key = `missing-pull-timestamp-${crypto.randomUUID()}`;
    const invalidDependencies: CloudSyncDependencies = {
      ...dependencies(new DurableFakeServer()),
      fetch: async input => {
        const path = String(input);
        if (path.includes('/sync/pull')) {
          return Response.json({
            records: [{
              entityType: 'tasks', entityId: 'remote-task', version: 1, serverVersion: 1,
              deviceId: 'device-b', payload: task('not durable', 'remote-task'), deletedAt: null
            }],
            nextCursor: 1,
            hasMore: false
          });
        }
        if (path.endsWith('/sync/conflicts')) return Response.json({ conflicts: [] });
        return new Response(null, { status: 404 });
      }
    };

    await expect(synchronizeCloudOnce(key, invalidDependencies)).rejects.toThrow(/cursor was not advanced/i);
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).cursor).toBe(0);
    expect(await storageService.get(STORES.TASKS, key)).toBeUndefined();
  });

  it('preserves both conflict sides when the server acknowledges a different row', async () => {
    const key = `conflict-ack-mismatch-${crypto.randomUUID()}`;
    const conflictId = '99999999-9999-4999-8999-999999999999';
    const mutationId = '88888888-8888-4888-8888-888888888888';
    const localTask = task('local choice', 'conflicted-task');
    const cloudTask = task('cloud choice', 'conflicted-task');
    const meta = emptySyncMeta();
    meta.conflicts = [{
      id: conflictId,
      kind: 'push-rejected',
      entityType: 'tasks',
      entityId: 'conflicted-task',
      mutationId,
      localPayload: localTask,
      localDeletedAt: null,
      localHistory: [{
        mutationId,
        payload: localTask,
        deletedAt: null,
        updatedAt: '2026-08-27T00:00:00.000Z',
        version: 1
      }],
      serverPayload: cloudTask,
      serverMissing: false,
      serverDeletedAt: null,
      serverVersion: 2,
      createdAt: '2026-08-27T00:00:01.000Z',
      status: 'unresolved'
    }];
    await storageService.set(STORES.SYNC, key, meta, 'cloud');
    await storageService.set(STORES.TASKS, key, [localTask], 'cloud');
    let submitted: Record<string, unknown> | undefined;
    const mismatchDependencies: CloudSyncDependencies = {
      ...dependencies(new DurableFakeServer()),
      fetch: async (_input, init) => {
        submitted = JSON.parse(String(init?.body));
        return Response.json({
          resolved: true,
          conflictId: '77777777-7777-4777-8777-777777777777',
          mutationId
        });
      }
    };

    await expect(resolveLocalConflict(key, conflictId, 'cloud', mismatchDependencies))
      .rejects.toThrow(/exact conflict/i);
    expect(submitted).toEqual({ conflictId, mutationId, choice: 'cloud' });
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).conflicts)
      .toHaveLength(1);
    expect(await storageService.get(STORES.TASKS, key)).toEqual([localTask]);
  });

  it('rejects duplicated acknowledgement bodies without removing the outbox', async () => {
    const key = `duplicate-response-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('one')]);
    server.duplicateResults = true;

    await expect(synchronizeCloudOnce(key, dependencies(server))).rejects.toThrow('exactly');
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).outbox).toHaveLength(1);
    expect(server.records.size).toBe(1);
  });

  it('preserves a staged creation across a simulated client kill before IndexedDB commit', async () => {
    const key = `client-kill-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('survived kill')]);

    // No storageService.set call occurred: only the synchronous WAL exists.
    expect(await storageService.get(STORES.TASKS, key)).toEqual([task('survived kill')]);
    const meta = await synchronizeCloudOnce(key, dependencies(server));
    expect(meta.outbox).toHaveLength(0);
    expect(server.records.get('tasks:task-1')?.payload).toMatchObject({ title: 'survived kill' });
  });

  it('leaves local execution untouched while offline for an arbitrary duration', async () => {
    const key = `offline-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('days offline')]);
    const offlineDependencies = { ...dependencies(server), isOnline: () => false };

    const meta = await synchronizeCloudOnce(key, offlineDependencies);
    expect(meta.outbox).toHaveLength(1);
    expect(await storageService.get(STORES.TASKS, key)).toEqual([task('days offline')]);
    expect(server.records.size).toBe(0);
  });

  it('durably hydrates a PostgreSQL-only conflict on a clean client', async () => {
    const key = `server-conflict-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    server.conflicts.push({
      id: '99999999-9999-4999-8999-999999999999',
      entity_type: 'tasks',
      entity_id: 'valuable-task',
      mutation_id: '88888888-8888-4888-8888-888888888888',
      local_payload: task('newer pre-restore version', 'valuable-task'),
      local_deleted_at: null,
      local_version: 7,
      local_updated_at: '2026-08-26T00:00:00.000Z',
      server_payload: task('restored version', 'valuable-task'),
      server_deleted_at: null,
      server_missing: false,
      server_version: 12,
      created_at: '2026-08-27T00:00:00.000Z'
    });

    const first = await synchronizeCloudOnce(key, dependencies(server));
    expect(first.conflicts).toHaveLength(1);
    expect(first.conflicts[0]).toMatchObject({
      localPayload: expect.objectContaining({ title: 'newer pre-restore version' }),
      serverPayload: expect.objectContaining({ title: 'restored version' }),
      serverVersion: 12
    });
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).conflicts).toHaveLength(1);

    const retry = await synchronizeCloudOnce(key, dependencies(server));
    expect(retry.conflicts).toHaveLength(1);
  });

  it('preserves a create then completion before the first sync and deduplicates a repeated tap', async () => {
    const key = `create-complete-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const created = task('created offline');
    const completed = task('created offline', 'task-1', {
      completed: true,
      lifecycleStatus: 'completed',
      completedAt: 1_777_777
    });
    storageService.stageLocalValue(STORES.TASKS, key, [], [created]);
    storageService.stageLocalValue(STORES.TASKS, key, [created], [completed]);
    expect(storageService.stageLocalValue(STORES.TASKS, key, [completed], [completed])).toBeNull();

    const meta = await synchronizeCloudOnce(key, dependencies(server));
    expect(meta.outbox).toHaveLength(0);
    expect(meta.conflicts).toHaveLength(0);
    expect(server.receipts.size).toBe(2);
    expect(server.records.get('tasks:task-1')?.payload).toMatchObject({
      completed: true,
      lifecycleStatus: 'completed'
    });
  });

  it('converges independent task edits from two devices without a store-level conflict', async () => {
    const keyA = `different-a-${crypto.randomUUID()}`;
    const keyB = `different-b-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    storageService.stageLocalValue(STORES.TASKS, keyA, [], [task('from A', 'task-a')]);
    storageService.stageLocalValue(STORES.TASKS, keyB, [], [task('from B', 'task-b')]);

    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));
    const metaA = await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));

    expect(metaA.conflicts).toHaveLength(0);
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, keyB)).conflicts).toHaveLength(0);
    expect((await storageService.get<any[]>(STORES.TASKS, keyA))?.map(item => item.id).sort()).toEqual(['task-a', 'task-b']);
    expect((await storageService.get<any[]>(STORES.TASKS, keyB))?.map(item => item.id).sort()).toEqual(['task-a', 'task-b']);
  });

  it('preserves both same-task versions when devices complete and reschedule concurrently', async () => {
    const keyA = `same-a-${crypto.randomUUID()}`;
    const keyB = `same-b-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const initial = task('shared');
    storageService.stageLocalValue(STORES.TASKS, keyA, [], [initial]);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    const completed = task('shared', 'task-1', {
      completed: true,
      lifecycleStatus: 'completed',
      completedAt: 2_000
    });
    const rescheduled = task('shared', 'task-1', {
      scheduledFor: '2026-08-29',
      dateAssigned: '2026-08-29',
      updatedAt: 3
    });
    storageService.stageLocalValue(STORES.TASKS, keyA, [initial], [completed]);
    storageService.stageLocalValue(STORES.TASKS, keyB, [initial], [rescheduled]);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    const metaB = await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    expect(metaB.conflicts).toHaveLength(1);
    expect(metaB.outbox).toHaveLength(0);
    expect(metaB.conflicts[0].localPayload).toMatchObject({ scheduledFor: '2026-08-29' });
    expect(metaB.conflicts[0].serverPayload).toMatchObject({ completed: true });
    expect(await storageService.get(STORES.TASKS, keyB)).toEqual([rescheduled]);
    expect(server.records.get('tasks:task-1')?.payload).toMatchObject({ completed: true });
  });

  it('turns a stale edit after a tombstone into a recoverable conflict instead of resurrection', async () => {
    const keyA = `delete-a-${crypto.randomUUID()}`;
    const keyB = `delete-b-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const initial = task('will be removed');
    storageService.stageLocalValue(STORES.TASKS, keyA, [], [initial]);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    storageService.stageLocalValue(STORES.TASKS, keyA, [initial], []);
    const staleEdit = task('stale edit', 'task-1', { updatedAt: 4 });
    storageService.stageLocalValue(STORES.TASKS, keyB, [initial], [staleEdit]);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    const metaB = await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    expect(metaB.conflicts).toHaveLength(1);
    expect(metaB.conflicts[0].localPayload).toMatchObject({ title: 'stale edit' });
    expect(metaB.conflicts[0].serverDeletedAt).not.toBeNull();
    expect(await storageService.get(STORES.TASKS, keyB)).toEqual([staleEdit]);
    expect(server.records.get('tasks:task-1')?.deletedAt).not.toBeNull();
  });
});
