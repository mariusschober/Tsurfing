import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it } from 'vitest';
import { storageService } from '../../../services/storage';

const fixture = () => {
  const values = new Map<string, string>();
  const original = `s1-synthetic-original-${crypto.randomUUID()}`;
  values.set('goalflow_active_database_v2', original);
  const localStorage = {
    get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
  Object.assign(globalThis, { window: { localStorage, dispatchEvent: () => true }, localStorage });
  return { values, original, user: crypto.randomUUID() };
};

it('review: fallback must not shadow an acknowledged committed projection', async () => {
  const { values, user } = fixture();
  const current = [{ id: 'a', title: 'acknowledged' }];
  await storageService.applyRemotePage(user, [{ entityType: 'tasks', entityId: 'a', version: 1, serverVersion: 1, payload: current[0], deviceId: 'peer', deletedAt: null }], 1, 'local');
  values.set(`goalflow_fallback_tasks_${user}`, JSON.stringify([{ id: 'a', title: 'old fallback' }]));
  expect(await storageService.get('tasks', user)).toEqual(current);
});

it('review: explicit set must not silently discard its value when another store has WAL', async () => {
  const { user } = fixture();
  await storageService.set('tasks', user, [], 'cloud');
  storageService.stageLocalValue('tasks', user, [], [{ id: 'a', title: 'captured task' }]);
  await storageService.set('amalgam', user, 'independent note');
  expect(await storageService.get('amalgam', user)).toBe('independent note');
});
