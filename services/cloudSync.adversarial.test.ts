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
import { SyncMutationTooLargeError } from './syncEnvelope';

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
  readonly reconciliations: Array<{ candidate: any; previousCloud?: ServerRecord }> = [];
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
    if (path.endsWith('/sync/conflicts/reconcile')) {
      const candidate = JSON.parse(String(init?.body));
      const key = `${candidate.entityType}:${candidate.entityId}`;
      const previousCloud = this.records.get(key);
      this.reconciliations.push({ candidate, previousCloud });
      const latest = [...candidate.localHistory].sort((a: any, b: any) => b.version - a.version)[0];
      if (latest && (!previousCloud || Date.parse(latest.updatedAt) > Date.parse(previousCloud.updatedAt))) {
        this.records.set(key, {
          entityType: candidate.entityType, entityId: candidate.entityId, deviceId: 'server-auto-reconcile',
          version: Math.max(latest.version, (previousCloud?.version ?? 0) + 1), serverVersion: ++this.sequence.value,
          payload: latest.payload, updatedAt: latest.updatedAt, deletedAt: latest.deletedAt
        });
      }
      const record = this.records.get(key);
      const index = this.conflicts.findIndex(item => item.id === candidate.conflictId);
      if (index >= 0) this.conflicts.splice(index, 1);
      return Response.json({ reconciled: true, receiptId: crypto.randomUUID(), candidate,
        serverMissing: !record, record: record ? {
          entity_type: record.entityType, entity_id: record.entityId, device_id: record.deviceId,
          version: record.version, server_version: record.serverVersion, payload: record.payload,
          updated_at: record.updatedAt, deleted_at: record.deletedAt
        } : null });
    }
    if (path.includes('/sync/conflicts/page')) {
      const after = new URL(path, 'https://synthetic.invalid').searchParams.get('after') ?? '';
      const conflicts = this.conflicts.filter(row => String(row.id) > after)
        .sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(0, 20);
      return Response.json({ conflicts, hasMore: conflicts.length > 0, nextAfter: conflicts.at(-1)?.id ?? null });
    }
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

  it('resumes a complete staged history after an interrupted chunk without dropping evidence', async () => {
    const key = `staged-history-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const history = Array.from({ length: 1001 }, (_, i) => ({ mutationId: crypto.randomUUID(), version: i + 1,
      payload: { notes: `${i}:` + '🧭'.repeat(80) }, updatedAt: '2026-09-07T00:00:00.123456789Z', deletedAt: null }));
    const meta = emptySyncMeta();
    meta.conflicts = [{ id: crypto.randomUUID(), kind: 'remote-vs-local', entityType: 'settings', entityId: 'singleton',
      localPayload: history.at(-1)!.payload, localDeletedAt: null, localHistory: history, serverPayload: null,
      serverMissing: true, serverDeletedAt: null, serverVersion: 0, createdAt: '2026-09-07T00:00:00.000Z', status: 'unresolved' }];
    await storageService.set(STORES.SYNC, key, meta, 'cloud');
    const chunks = new Map<number, string>();
    let interrupt = true;
    let replays = 0;
    const runtime = dependencies(server);
    runtime.fetch = async (input, init) => {
      const path = String(input);
      if (path.endsWith('/sync/conflicts/stage')) {
        const raw = String(init?.body);
        expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(262144);
        const chunk = JSON.parse(raw);
        if (interrupt && chunk.chunkIndex === 1) { interrupt = false; return Response.json({ staged: false }); }
        if (chunks.has(chunk.chunkIndex)) { expect(chunks.get(chunk.chunkIndex)).toBe(raw); replays++; }
        chunks.set(chunk.chunkIndex, raw);
        return Response.json({ staged: true, manifest: chunk.manifest, chunkIndex: chunk.chunkIndex, chunkSha256: chunk.chunkSha256 });
      }
      if (path.endsWith('/sync/conflicts/reconcile-staged')) {
        const manifest = JSON.parse(String(init?.body));
        expect(chunks.size).toBe(manifest.chunkCount);
        const body = Buffer.concat([...chunks].sort((a, b) => a[0] - b[0]).map(([, raw]) => Buffer.from(JSON.parse(raw).data, 'base64'))).toString('utf8');
        expect(JSON.parse(body).localHistory).toEqual(history);
        return server.fetch('/api/v1/sync/conflicts/reconcile', { method: 'POST', body });
      }
      return server.fetch(path, init);
    };
    await expect(synchronizeCloudOnce(key, runtime, { seedLocalData: false })).rejects.toThrow(/chunk/);
    expect(normalizeSyncMeta(await storageService.get(STORES.SYNC, key)).conflicts[0].localHistory).toEqual(history);
    expect(server.reconciliations).toHaveLength(0);
    const done = await synchronizeCloudOnce(key, runtime, { seedLocalData: false });
    expect(replays).toBe(1);
    expect(done.conflicts).toHaveLength(0);
    expect(server.reconciliations[0].candidate.localHistory).toEqual(history);
    expect(await storageService.get(STORES.SETTINGS, key)).toEqual(history.at(-1)!.payload);
  });

  it('preserves an oversize captured change without marking an unmade network attempt', async () => {
    const key = `oversize-${crypto.randomUUID()}`;
    storageService.stageLocalValue(STORES.TASKS, key, [], [task('preserved', 'large', { notes: '🧭'.repeat(70_000) })]);
    await storageService.flushPendingLocalChanges(key);
    const before = normalizeSyncMeta(await storageService.get(STORES.SYNC, key));
    let requests = 0;
    const runtime = { ...dependencies(new DurableFakeServer()), fetch: async () => {
      requests++;
      return Response.json({});
    } };
    for (let retry = 0; retry < 2; retry++) {
      await expect(synchronizeCloudOnce(key, runtime, { seedLocalData: false })).rejects.toBeInstanceOf(SyncMutationTooLargeError);
    }
    expect(requests).toBe(0);
    const after = normalizeSyncMeta(await storageService.get(STORES.SYNC, key));
    expect(after.outbox).toEqual(before.outbox);
    expect(after.cursor).toBe(before.cursor);
  });

  it('drains valid multibyte notes within the actual JSON body limit without changing receipts', async () => {
    const key = `byte-batches-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const tasks = Array.from({ length: 7 }, (_, i) => task('large note', `large-${i}`, {
      notes: '🧭"\\\n'.repeat(14_000)
    }));
    storageService.stageLocalValue(STORES.TASKS, key, [], tasks);
    const sizes: number[] = [];
    const runtime = dependencies(server);
    runtime.fetch = async (path, init) => {
      if (String(path).endsWith('/sync/push')) {
        const bytes = new TextEncoder().encode(String(init?.body)).byteLength;
        sizes.push(bytes);
        if (bytes > 256 * 1024) return Response.json({ error: { code: 'too_large' } }, { status: 413 });
      }
      return server.fetch(String(path), init);
    };
    const meta = await synchronizeCloudOnce(key, runtime, { seedLocalData: false });
    expect(meta.outbox).toHaveLength(0);
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every(size => size <= 256 * 1024)).toBe(true);
    expect(server.receipts.size).toBe(tasks.length);
    for (const item of tasks) expect(server.records.get(`tasks:${item.id}`)?.payload).toEqual(item);
  });

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
        if (path.includes('/sync/conflicts/page')) return Response.json({ conflicts: [], hasMore: false, nextAfter: null });
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

  it('automatically reconciles a PostgreSQL-only conflict on a clean client', async () => {
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

    server.sequence.value = 12;
    server.records.set('tasks:valuable-task', { entityType: 'tasks', entityId: 'valuable-task',
      deviceId: 'cloud', version: 6, serverVersion: 12, updatedAt: '2026-08-25T00:00:00Z', deletedAt: null,
      payload: task('restored version', 'valuable-task') });
    const first = await synchronizeCloudOnce(key, dependencies(server));
    expect(first.conflicts).toHaveLength(0);
    expect(await storageService.get(STORES.TASKS, key)).toEqual([task('newer pre-restore version', 'valuable-task')]);
    expect(server.reconciliations[0].candidate.localHistory[0].payload.title).toBe('newer pre-restore version');
    expect(server.reconciliations[0].previousCloud?.payload).toMatchObject({ title: 'restored version' });
    const retry = await synchronizeCloudOnce(key, dependencies(server));
    expect(retry.conflicts).toHaveLength(0);
    expect(server.reconciliations).toHaveLength(1);
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

  it('automatically converges concurrent changes by edit time while preserving both in the audit', async () => {
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
      completedAt: 2_000, updatedAt: 2_000
    });
    const rescheduled = task('shared', 'task-1', {
      scheduledFor: '2026-08-29',
      dateAssigned: '2026-08-29',
      updatedAt: 3_000
    });
    storageService.stageLocalValue(STORES.TASKS, keyA, [initial], [completed], true);
    storageService.stageLocalValue(STORES.TASKS, keyB, [initial], [rescheduled], true);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    const metaB = await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    expect(metaB.conflicts).toHaveLength(0);
    expect(metaB.outbox).toHaveLength(0);
    expect(server.reconciliations[0].candidate.localHistory[0].payload).toMatchObject({ scheduledFor: '2026-08-29' });
    expect(server.reconciliations[0].previousCloud?.payload).toMatchObject({ completed: true });
    expect(await storageService.get(STORES.TASKS, keyB)).toEqual([rescheduled]);
    expect(server.records.get('tasks:task-1')?.payload).toMatchObject({ scheduledFor: '2026-08-29' });
  });

  it('automatically keeps a newer cloud deletion and archives the stale local edit', async () => {
    const keyA = `delete-a-${crypto.randomUUID()}`;
    const keyB = `delete-b-${crypto.randomUUID()}`;
    const server = new DurableFakeServer();
    const initial = task('will be removed');
    storageService.stageLocalValue(STORES.TASKS, keyA, [], [initial]);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    storageService.stageLocalValue(STORES.TASKS, keyA, [initial], []);
    const staleEdit = task('stale edit', 'task-1', { updatedAt: 4 });
    storageService.stageLocalValue(STORES.TASKS, keyB, [initial], [staleEdit], true);
    await synchronizeCloudOnce(keyA, dependencies(server, 'device-a'));
    const metaB = await synchronizeCloudOnce(keyB, dependencies(server, 'device-b'));

    expect(metaB.conflicts).toHaveLength(0);
    expect(server.reconciliations[0].candidate.localHistory[0].payload).toMatchObject({ title: 'stale edit' });
    expect(server.reconciliations[0].previousCloud?.deletedAt).not.toBeNull();
    expect(await storageService.get(STORES.TASKS, keyB)).toEqual([]);
    expect(server.records.get('tasks:task-1')?.deletedAt).not.toBeNull();
  });
});
