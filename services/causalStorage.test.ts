import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { CAUSAL_STORE, TRACKING_KEY_PATH, fenceLegacyTracking, readCausalAccount } from './causalStorage';

async function seed() {
  const name = `s2-fence-${crypto.randomUUID()}`;
  const db = await openDB(name, 1, { upgrade(db) { db.createObjectStore('tracking'); db.createObjectStore('sync'); } });
  const tracking = { date: '2026-09-07', planViewCount: 27, dailyPostponeCount: 3, focusSession: { malformed: true }, unknown: { value: [0, false, null] } };
  const sync = { cursor: 10, outbox: [{ mutationId: 'original', payload: tracking, attemptedAt: '2026-09-07T10:00:00.123456789Z' }], localState: { receipts: { exact: { original: true } } } };
  await db.put('tracking', tracking, 'account');
  await db.put('tracking', null, 'malformed');
  await db.put('sync', sync, 'account');
  await db.put('sync', { unknown: true }, 'sync-only');
  db.close();
  return { name, tracking, sync };
}

describe('causal IndexedDB compatibility fence', () => {
  it('preserves all keys, malformed optional values and original receipt preimages', async () => {
    const { name, tracking, sync } = await seed();
    const db = await fenceLegacyTracking(name);
    expect(db.name).toBe(name);
    expect(db.transaction('tracking').store.keyPath).toBe(TRACKING_KEY_PATH);
    expect(await db.getAllKeys('tracking')).toEqual(['account', 'malformed']);
    expect(await db.get('sync', 'account')).toEqual(sync);
    const state = await readCausalAccount(db.transaction([CAUSAL_STORE]), 'account');
    expect(state?.trackingValue).toEqual(tracking);
    expect(state?.cutover).toEqual({ trackingPresent: true, trackingValue: tracking, syncPresent: true, syncValue: sync });
    expect((await db.get(CAUSAL_STORE, 'malformed')).trackingValue).toBeNull();
    expect((await db.get(CAUSAL_STORE, 'sync-only')).trackingPresent).toBe(false);
    db.close();
    await deleteDB(name);
  });

  it('fences the legacy explicit-key put after reopening the newest version', async () => {
    const { name, tracking } = await seed();
    const upgraded = await fenceLegacyTracking(name);
    upgraded.close();
    const oldClient = await openDB(name); // Actual S1 open-without-version behavior.
    await expect(oldClient.put('tracking', { ...tracking, planViewCount: 0 }, 'account')).rejects.toMatchObject({ name: 'DataError' });
    await oldClient.delete('tracking', 'account');
    expect((await readCausalAccount(oldClient.transaction([CAUSAL_STORE]), 'account'))?.trackingValue).toEqual(tracking);
    oldClient.close();
    await deleteDB(name);
  });

  it('aborts atomically when a preservation write fails', async () => {
    const { name, tracking, sync } = await seed();
    const add = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'tracking') throw new Error('Synthetic disk failure after authority copy');
      return add.apply(this, args);
    });
    await expect(fenceLegacyTracking(name)).rejects.toThrow('Synthetic disk failure');
    spy.mockRestore();
    const db = await openDB(name);
    expect(db.version).toBe(1);
    expect(db.transaction('tracking').store.keyPath).toBeNull();
    expect(db.objectStoreNames.contains(CAUSAL_STORE)).toBe(false);
    expect(await db.get('tracking', 'account')).toEqual(tracking);
    expect(await db.get('sync', 'account')).toEqual(sync);
    db.close();
    await deleteDB(name);
  });

  it('concurrent and repeated migrations do not replace preserved evidence', async () => {
    const { name, sync } = await seed();
    const [a, b] = await Promise.all([fenceLegacyTracking(name), fenceLegacyTracking(name)]);
    expect(a.version).toBe(2);
    expect(b.version).toBe(2);
    expect((await b.get(CAUSAL_STORE, 'account')).cutover.syncValue).toEqual(sync);
    a.close(); b.close();
    const again = await fenceLegacyTracking(name);
    expect(again.version).toBe(2);
    again.close(); await deleteDB(name);
  });
});
