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

it('database connection replacement preserves original projection and incompatible captured intent', async () => {
  const { values, original, user } = fixture();
  const before = [{ id: 'a', title: 'original' }];
  await storageService.set('tasks', user, before, 'cloud');
  storageService.stageLocalValue('tasks', user, before, [{ id: 'a', title: 'captured' }]);
  const wal = [...values.entries()].filter(([key]) => key.startsWith('goalflow_wal'));
  // Only a synthetic fake-indexeddb profile is switched, emulating an external
  // pointer change while an old-tab action is still pending.
  values.set('goalflow_active_database_v2', `s1-synthetic-replacement-${crypto.randomUUID()}`);
  await expect(storageService.flushPendingLocalChanges(user)).rejects.toThrow(/Neither version/);
  expect(await (await openDB(original)).get('tasks', user)).toEqual(before);
  expect([...values.entries()].filter(([key]) => key.startsWith('goalflow_wal'))).toEqual(wal);
});

it('self-repair never activates a shadow database without a concurrent-admission fence', async () => {
  const { values, original, user } = fixture();
  await storageService.set('tasks', user, [{ id: 'a', title: 'preserved' }], 'cloud');
  const outcome = await storageService.runSelfRepair(user);
  expect(outcome.success).toBe(false);
  expect(outcome.message).toMatch(/automatic database replacement is paused/);
  expect(values.get('goalflow_active_database_v2')).toBe(original);
  expect(await storageService.get('tasks', user)).toEqual([{ id: 'a', title: 'preserved' }]);
});
