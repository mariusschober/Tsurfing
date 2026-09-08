import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { admitLocalTaskCompletion, type TaskCompletionIntent } from './causalTaskCompletion';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';

async function fixture() {
  const name = 's2-task-completion-' + crypto.randomUUID(), accountId = crypto.randomUUID();
  const day = '2026-09-08';
  const tracking = { date: day, planViewCount: 1, dailyPostponeCount: 0, focusSession: { retained: true }, unknown: ['keep'] };
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  const task = (id: string) => ({ id, title: 'Synthetic ' + id.slice(0, 8), completed: false, isFrog: false,
    dateAssigned: day, description: 'Synthetic notes', unknown: { preserved: true } });
  const db = await openDB(name, 1, { upgrade(db) {
    for (const store of ['tasks', 'tracking', 'sync', 'stats', 'goals', 'habits', 'progress', 'task_events']) db.createObjectStore(store);
  } });
  await db.put('tracking', tracking, accountId);
  await db.put('tasks', [task(firstId), task(secondId)], accountId);
  await db.put('progress', { level: 1, xp: 0, xpToNextLevel: 100 }, accountId);
  db.close();
  (await fenceLegacyTracking(name)).close();
  const intent = (taskId: string, actionId: string = crypto.randomUUID()): TaskCompletionIntent => ({ schemaVersion: 1,
    actionId, accountId, actorId: 'tab', deviceId: 'device', taskId,
    details: { day, timeZone: 'Atlantic/Canary' }, capturedAt: '2026-09-08T10:00:00.000Z' });
  const read = async () => { const db = await openDB(name);
    const state = await db.get(CAUSAL_STORE, accountId), tasks = await db.get('tasks', accountId),
      stats = await db.get('stats', accountId), progress = await db.get('progress', accountId),
      events = await db.get('task_events', accountId), meta = await db.get('sync', accountId);
    db.close(); return { state, tasks, stats, progress, events, meta }; };
  return { name, accountId, day, tracking, firstId, secondId, intent, read };
}
it('completes one task with all effects as ordinary mutations and reuses the admission on retry', async () => {
  const f = await fixture();
  const first = await admitLocalTaskCompletion(f.name, f.intent(f.firstId));
  expect(first.duplicate).toBe(false);
  expect(first.admission.earnedXp).toBe(10);
  expect(first.admission.dayComplete).toBe(false);
  const after = await f.read();
  expect(after.tasks.find((t: any) => t.id === f.firstId)).toMatchObject({ completed: true, lifecycleStatus: 'completed', description: 'Synthetic notes' });
  expect(after.tasks.find((t: any) => t.id === f.secondId)).toMatchObject({ completed: false });
  expect(after.stats[f.day]).toMatchObject({ tasksCompleted: 1 });
  expect(after.progress.xp).toBe(10);
  expect(after.events).toHaveLength(1);
  expect(after.events[0]).toMatchObject({ taskId: f.firstId, eventType: 'completed', localDate: f.day });
  expect(after.state.trackingValue).toEqual(f.tracking);
  expect(after.meta.outbox.length).toBeGreaterThan(0);
  expect(after.meta.outbox.every((m: any) => m.deviceId === 'device')).toBe(true);
  expect(after.meta.localState.completionReservations).toBeUndefined();
  const retry = await admitLocalTaskCompletion(f.name, f.intent(f.firstId, first.admission.intent.actionId));
  expect(retry.duplicate).toBe(true);
  expect(await f.read()).toEqual(after);
  await expect(admitLocalTaskCompletion(f.name, { ...f.intent(f.firstId), actionId: crypto.randomUUID() }))
    .rejects.toThrow();
});
it('derives concurrent completions from current state so both statistics compose', async () => {
  const f = await fixture();
  const a = f.intent(f.firstId), b = f.intent(f.secondId);
  await Promise.all([admitLocalTaskCompletion(f.name, a), admitLocalTaskCompletion(f.name, b)]);
  const after = await f.read();
  expect(after.tasks.every((t: any) => t.completed)).toBe(true);
  expect(after.stats[f.day].tasksCompleted).toBe(2);
  // The second admission observes the day complete and earns the bonus.
  expect(after.progress.xp).toBe(70);
  expect(after.events).toHaveLength(2);
  const byEntity = new Map<string, any[]>();
  for (const m of after.meta.outbox as any[]) {
    const list = byEntity.get(m.entityType + ':' + m.entityId) ?? [];
    list.push(m); byEntity.set(m.entityType + ':' + m.entityId, list);
  }
  for (const list of byEntity.values()) {
    const versions = list.map(m => m.version).sort((x, y) => x - y);
    expect(new Set(versions).size).toBe(versions.length);
  }
  const statsMutations = after.meta.outbox.filter((m: any) => m.entityType === 'stats');
  expect(statsMutations).toHaveLength(2);
  expect(statsMutations[1].dependsOnMutationId).toBe(statsMutations[0].mutationId);
});
it('rolls back every collection, outbox and journal effect when the final write fails', async () => {
  const f = await fixture(); const before = await f.read(); const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === 'tasks') throw new Error('Synthetic task completion failure');
    return put.apply(this, args);
  });
  try { await expect(admitLocalTaskCompletion(f.name, f.intent(f.firstId))).rejects.toThrow('Synthetic'); } finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  await admitLocalTaskCompletion(f.name, f.intent(f.firstId));
  expect((await f.read()).tasks.find((t: any) => t.id === f.firstId).completed).toBe(true);
});
it('requires the prepared causal account and rejects malformed intent without writing', async () => {
  const f = await fixture(); const before = await f.read();
  await expect(admitLocalTaskCompletion('s2-missing-' + crypto.randomUUID(), f.intent(f.firstId))).rejects.toThrow();
  await expect(admitLocalTaskCompletion(f.name, { ...f.intent(f.firstId), taskId: '' })).rejects.toThrow('Invalid task completion intent');
  await expect(admitLocalTaskCompletion(f.name, { ...f.intent('missing'), actionId: crypto.randomUUID() })).rejects.toThrow();
  expect(await f.read()).toEqual(before);
});
it('preserves explicit empty final notes as an edit and retains existing notes when absent', async () => {
  const f = await fixture();
  await admitLocalTaskCompletion(f.name, { ...f.intent(f.firstId), details: { ...f.intent(f.firstId).details, finalDescription: '' } });
  const after = await f.read();
  expect(after.tasks.find((t: any) => t.id === f.firstId).description).toBe('');
});
