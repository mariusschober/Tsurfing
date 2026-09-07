import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { storageService as storage } from './storage';

const fixture = () => {
  const bytes = new Map<string, string>();
  const events: Event[] = [];
  const name = `s1-completion-${crypto.randomUUID()}`;
  bytes.set('goalflow_active_database_v2', name);
  const localStorage = {
    get length() { return bytes.size; }, key: (index: number) => [...bytes.keys()][index] ?? null,
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => { bytes.set(key, value); },
    removeItem: (key: string) => { bytes.delete(key); }
  };
  Object.assign(globalThis, { localStorage, window: { localStorage, dispatchEvent: (event: Event) => { events.push(event); return true; } } });
  return { bytes, events, name, user: crypto.randomUUID() };
};
const wal = (bytes: Map<string, string>) => [...bytes].filter(([key]) => key.startsWith('goalflow_wal'));
const remote = (payload: any, version = 1, deletedAt: string | null = null) => ({ entityType: 'tasks', entityId: 'a', version,
  serverVersion: version, payload, deletedAt, deviceId: 'peer' });

describe('S1 correction acceptance', () => {
  it('F: acknowledged tombstones cannot be resurrected by fallback recovery', async () => {
    const { bytes, name, user } = fixture();
    await storage.applyRemotePage(user, [remote({ id: 'a', title: 'acknowledged' })], 1, 'local');
    await storage.applyRemotePage(user, [remote(null, 2, '2026-09-07T10:00:00.000Z')], 2, 'local');
    const key = `goalflow_fallback_tasks_${user}`;
    const original = JSON.stringify([{ id: 'a', title: 'old mirror' }]);
    bytes.set(key, original);
    expect(await storage.get('tasks', user)).toEqual([]);
    await expect(storage.flushPendingLocalChanges(user)).rejects.toMatchObject({ code: 'FALLBACK_HISTORY_CONFLICT' });
    expect(bytes.get(key)).toBe(original);
    const db = await openDB(name);
    expect(await db.get('tasks', user)).toEqual([]);
    expect((await db.get('sync', user)).cursor).toBe(2);
  });

  it('F: identical fallback recovery commits a generation and retains a peer replacement during commit', async () => {
    const { bytes, events, user } = fixture();
    const tasks = [{ id: 'a', title: 'same' }];
    await storage.set('tasks', user, tasks, 'cloud');
    const before = await storage.get<any>('sync', user);
    const key = `goalflow_fallback_tasks_${user}`;
    bytes.set(key, JSON.stringify(tasks));
    const changed = JSON.stringify([{ id: 'b', title: 'new fallback admitted by peer' }]);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      const result = put.apply(this, args);
      if (this.name === 'tasks') result.addEventListener('success', () => bytes.set(key, changed), { once: true });
      return result;
    });
    try { await storage.flushPendingLocalChanges(user); } finally { spy.mockRestore(); }
    expect(bytes.get(key)).toBe(changed);
    expect(await storage.get('tasks', user)).toEqual(tasks);
    expect((await storage.get<any>('sync', user)).localState.generation).toBeGreaterThan(before.localState.generation);
    expect(events.some(e => e.type === 'goalflow:committed')).toBe(true);
  });

  it('F: incompatible fallback aborts without changing cursor, projection or bytes', async () => {
    const { bytes, name, user } = fixture();
    await storage.applyRemotePage(user, [remote({ id: 'a', title: 'current' })], 1, 'local');
    const db = await openDB(name);
    const meta = await db.get('sync', user);
    bytes.set(`goalflow_fallback_tasks_${user}`, JSON.stringify([{ id: 'a', title: 'ambiguous' }]));
    const preserved = [...bytes];
    await expect(storage.flushPendingLocalChanges(user)).rejects.toThrow(/conflicts/);
    expect([...bytes]).toEqual(preserved);
    expect(await db.get('sync', user)).toEqual(meta);
    expect(await storage.get('tasks', user)).toEqual([{ id: 'a', title: 'current' }]);
  });

  it('R1: pending overlay includes independent committed records and ignores retired WAL', async () => {
    const { bytes, user } = fixture();
    await storage.set('tasks', user, [{ id: 'peer', title: 'peer' }], 'cloud');
    storage.stageLocalValue('tasks', user, [], [{ id: 'a', title: 'local' }]);
    const original = wal(bytes);
    expect(await storage.get('tasks', user)).toEqual([{ id: 'peer', title: 'peer' }, { id: 'a', title: 'local' }]);
    await storage.flushPendingLocalChanges(user);
    await storage.set('tasks', user, [{ id: 'peer', title: 'new peer' }, { id: 'a', title: 'new local' }], 'cloud');
    for (const [key, value] of original) bytes.set(key, value);
    expect(await storage.get('tasks', user)).toEqual([{ id: 'peer', title: 'new peer' }, { id: 'a', title: 'new local' }]);
  });

  it('R2: explicit same-store set admits its own action, identical repeat creates none', async () => {
    const { name, user } = fixture();
    storage.stageLocalValue('tasks', user, [], [{ id: 'a', title: 'captured' }]);
    const requested = [{ id: 'a', title: 'explicit' }];
    await storage.set('tasks', user, requested);
    const first = await storage.get<any>('sync', user);
    expect(first.outbox).toHaveLength(2);
    await storage.set('tasks', user, requested);
    expect((await storage.get<any>('sync', user)).outbox).toEqual(first.outbox);
    expect(await (await openDB(name)).get('tasks', user)).toEqual(requested);
  });

  it('R2: aborted explicit write rejects and preserves its captured intent for restart', async () => {
    const { bytes, name, user } = fixture();
    await storage.set('amalgam', user, 'before', 'cloud');
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'sync') throw new DOMException('synthetic abort', 'AbortError');
      return put.apply(this, args);
    });
    try { await expect(storage.set('amalgam', user, 'captured')).rejects.toThrow(/synthetic abort/); } finally { spy.mockRestore(); }
    expect(wal(bytes)).toHaveLength(1);
    expect(await (await openDB(name)).get('amalgam', user)).toBe('before');
    await storage.flushPendingLocalChanges(user);
    expect(await (await openDB(name)).get('amalgam', user)).toBe('captured');
  });

  it('D/E: an incompatible new group blocks as a whole without starving independent actions', async () => {
    const { bytes, name, user } = fixture();
    await storage.set('tasks', user, [], 'cloud');
    await storage.set('stats', user, { completed: 10 }, 'cloud');
    storage.stageLocalValues(user, [
      { storeName: 'tasks', previousValue: [], nextValue: [{ id: 'a', completed: true }] },
      { storeName: 'stats', previousValue: { completed: 0 }, nextValue: { completed: 1 } }
    ]);
    const original = wal(bytes)[0][1];
    storage.stageLocalValue('amalgam', user, undefined, 'independent note');
    const meta = await storage.flushPendingLocalChanges(user);
    const db = await openDB(name);
    expect(await db.get('tasks', user)).toEqual([]);
    expect(await db.get('stats', user)).toEqual({ completed: 10 });
    expect(await db.get('amalgam', user)).toBe('independent note');
    expect(Object.values(meta.localState?.blocked ?? {})).toEqual(expect.arrayContaining([expect.stringMatching(/STALE_GROUP_INTENT/)]));
    expect(Object.values(meta.localState?.groups ?? {})).toContain(original);
    expect((await storage.flushPendingLocalChanges(user)).outbox).toEqual(meta.outbox);
  });
});

it('B: already-resolved manual conflict still commits materialized WAL metadata', async () => {
  const { bytes, name, user } = fixture();
  storage.stageLocalValue('amalgam', user, undefined, 'must remain represented');
  const captured = JSON.parse(wal(bytes)[0][1]);
  await storage.resolveConflictWithCloud(user, 'already-resolved-by-peer');
  const db = await openDB(name);
  const meta = await db.get('sync', user);
  expect(await db.get('amalgam', user)).toBe('must remain represented');
  expect(meta.localState.journal[captured.id]).toEqual(captured);
  expect(meta.outbox[0].mutationId).toBe(captured.changes[0].mutationId);
});

it('F: metadata-only import cannot advance a cursor without its projection', async () => {
  const { user } = fixture();
  const meta = await storage.flushPendingLocalChanges(user);
  await expect(storage.set('sync', user, { ...meta, cursor: 20 })).rejects.toMatchObject({ code: 'CURSOR_REQUIRES_PROJECTION' });
  expect((await storage.get<any>('sync', user)).cursor).toBe(0);
});

it('bootstrap: repeated concurrent initialization and migration produce one audited action', async () => {
  const { user } = fixture();
  const task = { id: 'a', title: 'original', optional: null, future: { keep: true } };
  await Promise.all([storage.initializeIfAbsent('tasks', user, [task], true), storage.initializeIfAbsent('tasks', user, [{ id: 'other' }], true)]);
  await Promise.all([0, 1].map(() => storage.migrateCollectionV1<any[]>(user, 'tasks', 'synthetic-migration-v1', tasks => tasks.map(t => ({ ...t, migrated: true })))));
  const first = await storage.flushPendingLocalChanges(user);
  expect(await storage.get('tasks', user)).toEqual([{ ...task, migrated: true }]);
  expect(first.outbox).toHaveLength(2);
  await storage.migrateCollectionV1<any[]>(user, 'tasks', 'synthetic-migration-v1', () => { throw new Error('must never rerun'); });
  expect((await storage.get<any>('sync', user)).outbox).toEqual(first.outbox);
});

it('E: incompatible legacy group remains byte-identical and is never partially installed', async () => {
  const { bytes, name, user } = fixture();
  await storage.set('tasks', user, [], 'cloud');
  await storage.set('stats', user, { count: 8 }, 'cloud');
  storage.stageLocalValues(user, [
    { storeName: 'tasks', previousValue: [], nextValue: [{ id: 'a' }] },
    { storeName: 'stats', previousValue: { count: 0 }, nextValue: { count: 1 } }
  ]);
  const [key, original] = wal(bytes)[0];
  const legacy = JSON.parse(original); delete legacy.admissionVersion;
  const exact = JSON.stringify(legacy); bytes.set(key, exact);
  await expect(storage.flushPendingLocalChanges(user)).rejects.toThrow(/diverged/);
  expect(bytes.get(key)).toBe(exact);
  expect(await (await openDB(name)).get('tasks', user)).toEqual([]);
});

it.each(['before', 'during', 'after'] as const)('D: reconciliation with a %s admitted action preserves exact evidence', async timing => {
  const { bytes, name, user } = fixture();
  const { reconciliationCandidate } = await import('./syncProtocol');
  await storage.set('tasks', user, [{ id: 'a', title: 'old' }], 'cloud');
  storage.stageLocalValue('tasks', user, [{ id: 'a', title: 'old' }], [{ id: 'a', title: 'local' }]);
  const initial = await storage.applyRemotePage(user, [remote({ id: 'a', title: 'cloud' })], 1, 'local');
  const candidate = reconciliationCandidate(initial.meta.conflicts[0]);
  const reply = { reconciled: true, candidate, receiptId: crypto.randomUUID(), serverMissing: false,
    record: { entity_type: 'tasks', entity_id: 'a', payload: { id: 'a', title: 'cloud' }, version: 1,
      server_version: 1, device_id: 'peer', updated_at: '2026-09-07T10:00:00.000Z', deleted_at: null } };
  let original = '';
  const capture = () => {
    storage.stageLocalValue('tasks', user, [{ id: 'a', title: 'cloud' }], [{ id: 'a', title: 'new independent intent' }]);
    original = wal(bytes).at(-1)![1];
  };
  if (timing === 'before') capture();
  const get = IDBObjectStore.prototype.get;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
    const request = get.call(this, key);
    if (timing === 'during' && this.name === 'tasks' && key === user && !original) request.addEventListener('success', capture, { once: true });
    return request;
  });
  try { await storage.commitAutomaticReconciliation(user, candidate, reply); } finally { spy.mockRestore(); }
  if (timing === 'after') capture();
  const meta = await storage.flushPendingLocalChanges(user);
  const intent = JSON.parse(original);
  expect(meta.localState?.journal[intent.id]).toEqual(intent);
  const represented = [...meta.outbox.map(item => item.mutationId), ...meta.conflicts.flatMap(item => item.localHistory.map(h => h.mutationId))];
  expect(represented).toContain(intent.changes[0].mutationId);
  expect(Object.values(meta.localState?.reconciliations ?? {})).toContainEqual({ candidate, reply });
  if (timing === 'before') expect(meta.conflicts[0].localHistory.some(h => h.mutationId === intent.changes[0].mutationId)).toBe(true);
  else expect(Object.values(meta.localState?.resolvedConflicts ?? {})).toContainEqual(initial.meta.conflicts[0]);
  expect((await (await openDB(name)).get('sync', user)).localState).toEqual(meta.localState);
  expect((await storage.flushPendingLocalChanges(user)).outbox).toEqual(meta.outbox);
});
