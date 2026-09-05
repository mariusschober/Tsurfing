import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  mergeBackupCollection,
  normalizeBackupCollectionsForWeb,
  storageService,
  STORES,
  validateBackupCollections
} from './storage';

class TestLocalStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const installBrowserStorage = () => {
  const localStorage = new TestLocalStorage();
  (globalThis as any).window = {
    localStorage,
    dispatchEvent: () => true
  };
  (globalThis as any).localStorage = localStorage;
  return localStorage;
};

describe('backup merge behavior', () => {
  it('merges non-conflicting typed entity arrays by id and keeps records absent from the backup', () => {
    expect(mergeBackupCollection(
      [{ id: 'one', title: 'Local' }, { id: 'two', title: 'Keep' }],
      [{ id: 'one', title: 'Local' }, { id: 'three', title: 'Add' }]
    )).toEqual([
      { id: 'one', title: 'Local' },
      { id: 'two', title: 'Keep' },
      { id: 'three', title: 'Add' }
    ]);
  });

  it('refuses to silently select a version for keyed or unkeyed conflicts', () => {
    expect(() => mergeBackupCollection(
      [{ id: 'valuable-task', title: 'local version' }],
      [{ id: 'valuable-task', title: 'backup version' }]
    )).toThrow(/conflicts with existing data/i);
    expect(() => mergeBackupCollection({ enableAi: false }, { enableAi: true })).toThrow(/key "enableAi"/i);
    expect(() => mergeBackupCollection([1, 2], [3])).toThrow(/unkeyed collections/i);
  });

  it('maps safe native backup collections without dropping event or raw web data', () => {
    const event = { id: 'event-1', taskId: 'task-1', eventType: 'created' };
    const normalized = normalizeBackupCollectionsForWeb({
      plans: [{ localDate: '2026-08-27', taskIds: [], confirmedAt: 1 }],
      events: [event],
      outbox: [],
      syncMeta: [],
      conflicts: [],
      rawCollections: {
        stats: { __goalflowNativeRawJsonV1: '{"tasksCompleted":2}' }
      }
    });

    expect(normalized[STORES.DAILY_PLANS]).toEqual([{ localDate: '2026-08-27', taskIds: [], confirmedAt: 1 }]);
    expect(normalized[STORES.TASK_EVENTS]).toEqual([event]);
    expect(normalized[STORES.STATS]).toEqual({ tasksCompleted: 2 });
  });

  it('rejects native pending recovery state instead of silently dropping it', () => {
    expect(() => normalizeBackupCollectionsForWeb({
      tasks: [],
      outbox: [{ mutationId: 'valuable-pending-mutation' }],
      conflicts: []
    })).toThrow(/restore it in the native app/i);
  });
});

describe('durable storage failure boundaries', () => {
  it('recovers every store in a grouped UI mutation after a simulated process kill', async () => {
    installBrowserStorage();
    const key = `storage-group-kill-${crypto.randomUUID()}`;
    const tasks = [{ id: 'task', title: 'completed', completed: true }];
    const stats = { '2026-08-27': { tasksCompleted: 1, frogsEaten: 0, timeFocused: 25, totalBreakMinutes: 0 } };
    await storageService.set(STORES.STATS, key, {}, 'cloud');
    storageService.stageLocalValues(key, [
      { storeName: STORES.TASKS, previousValue: [], nextValue: tasks },
      { storeName: STORES.STATS, previousValue: {}, nextValue: stats }
    ]);

    // No IndexedDB write has run. Both values are nevertheless readable from
    // the single durable WAL entry after the modeled restart boundary.
    expect(await storageService.get(STORES.TASKS, key)).toEqual(tasks);
    expect(await storageService.get(STORES.STATS, key)).toEqual(stats);

    const meta = await storageService.flushPendingLocalChanges(key);
    expect(await storageService.get(STORES.TASKS, key)).toEqual(tasks);
    expect(await storageService.get(STORES.STATS, key)).toEqual(stats);
    expect(meta.outbox).toHaveLength(2);
    expect(meta.outbox.map(item => item.entityType).sort()).toEqual([STORES.STATS, STORES.TASKS]);
  });

  it('flushes an entire grouped mutation when a render effect persists only one member', async () => {
    installBrowserStorage();
    const key = `storage-group-effect-${crypto.randomUUID()}`;
    const tasks = [{ id: 'task', title: 'safe' }];
    const habits = [{ id: 'habit', title: 'streak', streak: 1 }];
    storageService.stageLocalValues(key, [
      { storeName: STORES.TASKS, previousValue: [], nextValue: tasks },
      { storeName: STORES.HABITS, previousValue: [], nextValue: habits }
    ]);

    await storageService.set(STORES.TASKS, key, tasks);

    expect(await storageService.get(STORES.HABITS, key)).toEqual(habits);
    const meta = await storageService.get<any>(STORES.SYNC, key);
    expect(meta.outbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: STORES.TASKS, entityId: 'task' }),
      expect.objectContaining({ entityType: STORES.HABITS, entityId: 'habit' })
    ]));
  });

  it('commits the newest WAL value when an older render effect flushes later', async () => {
    installBrowserStorage();
    const key = `storage-stale-effect-${crypto.randomUUID()}`;
    const first = [{ id: 'task', title: 'first render' }];
    const newest = [{ id: 'task', title: 'newest render' }];
    storageService.stageLocalValue(STORES.TASKS, key, [], first);
    storageService.stageLocalValue(STORES.TASKS, key, first, newest);

    await storageService.set(STORES.TASKS, key, first);
    expect(await storageService.get(STORES.TASKS, key)).toEqual(newest);
    const beforeSecondEffect = await storageService.get<any>(STORES.SYNC, key);
    await storageService.set(STORES.TASKS, key, newest);
    const afterSecondEffect = await storageService.get<any>(STORES.SYNC, key);
    expect(afterSecondEffect.outbox.map((item: any) => item.mutationId))
      .toEqual(beforeSecondEffect.outbox.map((item: any) => item.mutationId));
  });

  it('replays an offline WAL alongside an independently recovered task', async () => {
    installBrowserStorage();
    const key = `storage-wal-merge-${crypto.randomUUID()}`;
    const recovered = [{ id: 'remote', title: 'Recovered independently' }];
    const offline = [{ id: 'offline', title: 'Created while unavailable' }];
    await storageService.set(STORES.TASKS, key, recovered, 'cloud');
    storageService.stageLocalValue(STORES.TASKS, key, [], offline);

    const meta = await storageService.flushPendingLocalChanges(key);

    expect(await storageService.get(STORES.TASKS, key)).toEqual([...recovered, ...offline]);
    expect(meta.outbox).toHaveLength(1);
    expect(meta.outbox[0]).toMatchObject({ entityId: 'offline', payload: offline[0] });
  });

  it('does not replay a WAL over a divergent recovered version of the same task', async () => {
    const localStorage = installBrowserStorage();
    const key = `storage-wal-conflict-${crypto.randomUUID()}`;
    const recovered = [{ id: 'same', title: 'Recovered version' }];
    const believedPrevious = [{ id: 'same', title: 'Earlier version' }];
    const offline = [{ id: 'same', title: 'Offline version' }];
    await storageService.set(STORES.TASKS, key, recovered, 'cloud');
    storageService.stageLocalValue(STORES.TASKS, key, believedPrevious, offline);

    await expect(storageService.flushPendingLocalChanges(key)).rejects.toThrow(/Neither was overwritten/i);
    const walKeys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((candidate): candidate is string => Boolean(candidate?.startsWith('goalflow_wal_v2_')));
    expect(walKeys.length).toBeGreaterThan(0);
    walKeys.forEach(candidate => localStorage.removeItem(candidate));
    expect(await storageService.get(STORES.TASKS, key)).toEqual(recovered);
  });

  it('atomically recovers durable fallback data after an IndexedDB restart', async () => {
    installBrowserStorage();
    const key = `storage-fallback-recovery-${crypto.randomUUID()}`;
    const tasks = [{ id: 'fallback-task', title: 'Survived IndexedDB outage' }];
    const pending = {
      schemaVersion: 2,
      cursor: 0,
      versions: { 'tasks:fallback-task': { local: 1, server: null } },
      outbox: [{
        mutationId: crypto.randomUUID(),
        deviceId: 'device-a',
        entityType: 'tasks',
        entityId: 'fallback-task',
        baseServerVersion: null,
        version: 1,
        payload: tasks[0],
        updatedAt: new Date().toISOString(),
        deletedAt: null
      }],
      conflicts: []
    };
    window.localStorage.setItem(`goalflow_fallback_${STORES.TASKS}_${key}`, JSON.stringify(tasks));
    window.localStorage.setItem(`goalflow_fallback_${STORES.SYNC}_${key}`, JSON.stringify(pending));

    const recovered = await storageService.flushPendingLocalChanges(key);
    expect(await storageService.get(STORES.TASKS, key)).toEqual(tasks);
    expect(recovered.outbox).toHaveLength(1);
    expect(window.localStorage.getItem(`goalflow_fallback_${STORES.TASKS}_${key}`)).toBeNull();
    expect(window.localStorage.getItem(`goalflow_fallback_${STORES.SYNC}_${key}`)).toBeNull();
  });

  it('merges independent fallback records instead of replacing recovered IndexedDB data', async () => {
    const localStorage = installBrowserStorage();
    const key = `storage-fallback-merge-${crypto.randomUUID()}`;
    const indexed = [{ id: 'indexed-task', title: 'Already durable' }];
    const fallback = [{ id: 'fallback-task', title: 'Created during outage' }];
    await storageService.set(STORES.TASKS, key, indexed, 'cloud');
    localStorage.setItem(`goalflow_fallback_${STORES.TASKS}_${key}`, JSON.stringify(fallback));

    await storageService.flushPendingLocalChanges(key);

    expect(await storageService.get(STORES.TASKS, key)).toEqual([...indexed, ...fallback]);
  });

  it('keeps both copies untouched when fallback recovery finds a same-record divergence', async () => {
    const localStorage = installBrowserStorage();
    const key = `storage-fallback-conflict-${crypto.randomUUID()}`;
    const indexed = [{ id: 'same-task', title: 'IndexedDB version' }];
    const fallback = [{ id: 'same-task', title: 'Fallback version' }];
    const fallbackKey = `goalflow_fallback_${STORES.TASKS}_${key}`;
    await storageService.set(STORES.TASKS, key, indexed, 'cloud');
    localStorage.setItem(fallbackKey, JSON.stringify(fallback));

    await expect(storageService.flushPendingLocalChanges(key)).rejects.toThrow(/conflicts/i);
    expect(localStorage.getItem(fallbackKey)).toBe(JSON.stringify(fallback));
    localStorage.removeItem(fallbackKey);
    expect(await storageService.get(STORES.TASKS, key)).toEqual(indexed);
  });

  it('preserves call order when a write is immediately followed by delete', async () => {
    installBrowserStorage();
    const key = `storage-order-${Date.now()}`;
    await storageService.set(STORES.TASKS, key, [{ id: 'task-1', title: 'temporary' }], 'cloud');

    const write = storageService.set(STORES.TASKS, key, [{ id: 'task-2', title: 'newest' }], 'cloud');
    const remove = storageService.delete(STORES.TASKS, key);
    await Promise.all([write, remove]);

    expect(await storageService.get(STORES.TASKS, key)).toBeUndefined();
  });

  it('rejects malformed envelopes before touching existing state', () => {
    expect(() => validateBackupCollections({ schemaVersion: 2, collections: [] })).toThrow(
      'typed collections'
    );
    expect(validateBackupCollections({ schemaVersion: 2, collections: { tasks: [] } })).toEqual({ tasks: [] });
  });

  it('keeps the previous state after an import transaction aborts', async () => {
    installBrowserStorage();
    const key = `storage-import-${Date.now()}`;
    const previousTasks = [{ id: 'task-1', title: 'keep me' }];
    await storageService.set(STORES.TASKS, key, previousTasks, 'cloud');

    const malformedBackup = {
      schemaVersion: 2,
      collections: {
        [STORES.TASKS]: [() => 'not cloneable']
      }
    };
    await expect(storageService.importBackup(key, malformedBackup, 'replace')).rejects.toBeTruthy();
    expect(await storageService.get(STORES.TASKS, key)).toEqual(previousTasks);
  });

  it('round-trips representative state through export, destruction, and replace restore', async () => {
    installBrowserStorage();
    const key = `storage-roundtrip-${Date.now()}`;
    const tasks = [{ id: 'task-1', title: 'Ship the release' }];
    const goals = [{ id: 'goal-1', name: 'Reliable execution' }];
    await storageService.set(STORES.TASKS, key, tasks, 'cloud');
    await storageService.set(STORES.GOALS, key, goals, 'cloud');

    const backup = await storageService.exportBackup(key);
    await storageService.clear(STORES.TASKS);
    await storageService.clear(STORES.GOALS);
    expect(await storageService.get(STORES.TASKS, key)).toBeUndefined();
    expect(await storageService.get(STORES.GOALS, key)).toBeUndefined();

    await storageService.importBackup(key, backup, 'replace');
    expect(await storageService.get(STORES.TASKS, key)).toEqual(tasks);
    expect(await storageService.get(STORES.GOALS, key)).toEqual(goals);
  });

  it('backs up pending mutations and restores them into a clean client', async () => {
    installBrowserStorage();
    const sourceKey = `storage-pending-${crypto.randomUUID()}`;
    const tasks = [{ id: 'task-pending', title: 'Created without a network' }];
    storageService.stageLocalValue(STORES.TASKS, sourceKey, [], tasks);

    const backup = await storageService.exportBackup(sourceKey);
    const sourceMeta = (backup.collections[STORES.SYNC] as { outbox: unknown[] });
    expect(sourceMeta.outbox).toHaveLength(1);

    // A clean client for the same authenticated account uses the same owner
    // key. Remove the local copy to model a new browser profile, then restore.
    await storageService.delete(STORES.TASKS, sourceKey);
    await storageService.delete(STORES.SYNC, sourceKey);
    await storageService.importBackup(sourceKey, backup, 'replace');
    expect(await storageService.get(STORES.TASKS, sourceKey)).toEqual(tasks);
    const restoredMeta = await storageService.get<{ outbox: Array<{ mutationId: string }> }>(STORES.SYNC, sourceKey);
    expect(restoredMeta?.outbox.length).toBeGreaterThanOrEqual(1);
    expect(restoredMeta?.outbox.some(item => item.mutationId === (sourceMeta.outbox[0] as any).mutationId)).toBe(true);
  });

  it('rejects a current backup owned by another account before changing data', async () => {
    installBrowserStorage();
    const sourceKey = `storage-owner-source-${crypto.randomUUID()}`;
    const targetKey = `storage-owner-target-${crypto.randomUUID()}`;
    await storageService.set(STORES.TASKS, sourceKey, [{ id: 'source', title: 'source' }], 'cloud');
    await storageService.set(STORES.TASKS, targetKey, [{ id: 'target', title: 'must survive' }], 'cloud');
    const backup = await storageService.exportBackup(sourceKey);

    await expect(storageService.importBackup(targetKey, backup, 'replace')).rejects.toThrow('different Tsurfing account');
    expect(await storageService.get(STORES.TASKS, targetKey)).toEqual([{ id: 'target', title: 'must survive' }]);
  });

  it('rejects incomplete schema-3 integrity metadata', () => {
    expect(() => validateBackupCollections({ schemaVersion: 3, collections: { tasks: [] } }))
      .toThrow(/timestamp|checksum/i);
    expect(() => validateBackupCollections({
      schemaVersion: 3,
      exportedAt: 'not-a-date',
      checksum: '0'.repeat(64),
      collections: { tasks: [] }
    })).toThrow(/timestamp/i);
  });

  it('backs up an offline planning decision with its record-level outbox mutation', async () => {
    installBrowserStorage();
    const key = `storage-plan-${crypto.randomUUID()}`;
    const plans = [{
      id: '2099-03-01', localDate: '2099-03-01', taskIds: [crypto.randomUUID()], confirmedAt: Date.now()
    }];
    storageService.stageLocalValue(STORES.DAILY_PLANS, key, [], plans);

    const backup = await storageService.exportBackup(key);
    const meta = backup.collections[STORES.SYNC] as { outbox: Array<{ entityType: string; entityId: string }> };

    expect(backup.collections[STORES.DAILY_PLANS]).toEqual(plans);
    expect(meta.outbox).toContainEqual(expect.objectContaining({
      entityType: STORES.DAILY_PLANS,
      entityId: '2099-03-01'
    }));
  });

  it('rejects a checksum-corrupted backup before changing a clean client', async () => {
    installBrowserStorage();
    const key = `storage-corrupt-${crypto.randomUUID()}`;
    await storageService.set(STORES.TASKS, key, [{ id: 'source', title: 'source' }], 'cloud');
    const backup = await storageService.exportBackup(key);
    await storageService.set(STORES.TASKS, key, [{ id: 'target', title: 'must survive' }], 'cloud');
    const corrupted = structuredClone(backup);
    corrupted.collections[STORES.TASKS] = [{ id: 'source', title: 'tampered' }];

    await expect(storageService.importBackup(key, corrupted, 'replace')).rejects.toThrow('checksum');
    expect(await storageService.get(STORES.TASKS, key)).toEqual([{ id: 'target', title: 'must survive' }]);
  });

  it('rolls back when a restored mutation id collides with different pending data', async () => {
    installBrowserStorage();
    const key = `storage-collision-${crypto.randomUUID()}`;
    storageService.stageLocalValue(STORES.TASKS, key, [], [{ id: 'local', title: 'local' }]);
    await storageService.flushPendingLocalChanges(key);
    const currentMeta = await storageService.get<any>(STORES.SYNC, key);
    const mutation = currentMeta.outbox[0];
    const malformed = {
      schemaVersion: 2,
      collections: {
        [STORES.TASKS]: [{ id: 'backup', title: 'backup' }],
        [STORES.SYNC]: {
          ...currentMeta,
          outbox: [{ ...mutation, payload: { id: 'local', title: 'different payload' } }]
        }
      }
    };

    await expect(storageService.importBackup(key, malformed, 'replace')).rejects.toThrow('mutation id');
    expect(await storageService.get(STORES.TASKS, key)).toEqual([{ id: 'local', title: 'local' }]);
    expect((await storageService.get<any>(STORES.SYNC, key)).outbox[0].payload)
      .toEqual({ id: 'local', title: 'local' });
  });

  it('P1-1 memoizes listWal + latestWalValue within 200ms and idles >50 entries', async () => {
    const localStorage = installBrowserStorage();
    const key = `storage-p1-1-${crypto.randomUUID()}`;
    for (let i = 0; i < 60; i++) {
      storageService.stageLocalValue(STORES.TASKS, key, [], [{ id: `t-${i}`, title: `Task ${i}` }]);
    }
    let keyCalls = 0;
    const origKey = localStorage.key.bind(localStorage);
    (localStorage as unknown as { key: (idx: number) => string | null }).key = (idx: number) => {
      keyCalls++;
      return origKey(idx);
    };
    const first = await storageService.get(STORES.TASKS, key);
    expect(first).toBeDefined();
    const callsAfterFirst = keyCalls;
    keyCalls = 0;
    const second = await storageService.get(STORES.TASKS, key);
    expect(second).toEqual(first);
    // second call within debounce window should be memoized (no localStorage.key scan)
    expect(keyCalls).toBeLessThan(callsAfterFirst);
    expect(keyCalls).toBeLessThan(20);
  });
});
