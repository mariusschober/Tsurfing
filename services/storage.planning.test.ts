import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { storageService } from './storage';
import { PLANNING_STORE } from './deliberatePlanningStorage';
import { decodeCausalBackup } from './causalBackup';
import { openDB } from 'idb';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const values = new Map<string, string>([['goalflow_active_database_v2', `planning-backup-${crypto.randomUUID()}`]]);
  const localStorage = { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('window', { localStorage, dispatchEvent: () => true }); vi.stubGlobal('localStorage', localStorage);
  const accountId = crypto.randomUUID(), localDate = '2026-09-08';
  await storageService.set('tasks', accountId, ['a', 'b'].map((id, plannedOrder) => ({ id, title: id, plannedOrder,
    dateAssigned: localDate, createdAt: plannedOrder, completed: false })), 'cloud');
  await storageService.set('progress', accountId, { level: 1, xp: 200, xpToNextLevel: 500 }, 'cloud');
  await storageService.set('daily_plans', accountId, [], 'cloud');
  const command = { schemaVersion: 1 as const, operationId: crypto.randomUUID(), accountId, localDate,
    baselineRevision: null, proposedOrder: ['b', 'a'], ratings: [], maximumAcceptedXp: 0, capturedAt: '2026-09-08T18:00:00.000Z' };
  await storageService.confirmPlanningOrder(command);
  return { values, accountId, localDate, command };
}
it('exports and restores the exact pending planning journal into a clean profile', async () => {
  const f = await fixture();
  const backup = await storageService.exportBackup(f.accountId);
  expect(backup.schemaVersion).toBe(7);
  const state = decodeCausalBackup((backup.collections[PLANNING_STORE] as any).encoded) as any;
  expect(state.planning.pending[f.command.operationId].command).toEqual(f.command);
  expect(state.planning.pending[f.command.operationId].ordinaryDependencies.length).toBeGreaterThan(0);
  f.values.clear(); f.values.set('goalflow_active_database_v2', `planning-restored-${crypto.randomUUID()}`);
  await storageService.importBackup(f.accountId, backup, 'replace');
  const restored = await storageService.readDailyPlanning(f.accountId, f.localDate);
  expect(restored.pending[0].command).toEqual(f.command);
  expect(restored.policy.confirmedOrder).toEqual(['b', 'a']);
  await storageService.importBackup(f.accountId, backup, 'replace');
  expect((await storageService.readDailyPlanning(f.accountId, f.localDate)).pending).toHaveLength(1);
});
it('prevents direct journal deletion and locked order writes while allowing a note edit', async () => {
  const f = await fixture();
  await expect(storageService.delete(PLANNING_STORE, f.accountId)).rejects.toThrow('cannot be deleted');
  await expect(storageService.set(PLANNING_STORE, f.accountId, {})).rejects.toThrow('owning coordinator');
  const tasks = await storageService.get<any[]>('tasks', f.accountId);
  await storageService.set('tasks', f.accountId, tasks!.map(task => ({ ...task, description: 'allowed note' })));
  await expect(storageService.set('tasks', f.accountId, tasks!.map(task => ({ ...task, plannedOrder: 1 - task.plannedOrder })))).rejects.toThrow();
  const db = await openDB(f.values.get('goalflow_active_database_v2')!);
  expect(await db.get(PLANNING_STORE, f.accountId)).toBeDefined(); db.close();
});
