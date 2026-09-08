import 'fake-indexeddb/auto';
import { openDB, deleteDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { CAUSAL_BUSINESS_STORE, CAUSAL_BUSINESS_STORES, BUSINESS_KEY_PATH,
  fenceLegacyBusinessStores, causalBusinessTransactionStores, readCausalBusiness, writeCausalBusiness } from './causalBusinessStorage';

const names: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const name of names.splice(0)) await deleteDB(name); });
async function seed() {
  const name = `s2-business-fence-${crypto.randomUUID()}`; names.push(name);
  const db = await openDB(name, 1, { upgrade(db) {
    for (const store of ['tracking', 'snapshots', ...CAUSAL_BUSINESS_STORES]) db.createObjectStore(store);
  } });
  const original = { malformed: true, nested: [null, false, 0], notes: 'synthetic 🧭',
    attemptedRequest: '{"capturedAt":"2026-09-08T00:00:00.123456789Z"}', receipt: { original: true } };
  for (const store of CAUSAL_BUSINESS_STORES) {
    await db.put(store, original, 'account');
    await db.put(store, null, ['other', 2]);
    await db.put(store, undefined, 'present-undefined');
  }
  await db.put('tracking', { planViewCount: 27 }, 'account');
  await db.put('snapshots', original, 'historical'); db.close();
  (await fenceLegacyTracking(name)).close();
  return { name, original };
}
async function read(name: string, store: string, key: IDBValidKey = 'account') {
  const db = await openDB(name);
  try {
    const tx = db.transaction(causalBusinessTransactionStores(db, [store]));
    const value = await readCausalBusiness(tx, store, key); await tx.done; return value;
  } finally { db.close(); }
}
describe('business store compatibility fence', () => {
  it('preserves all account keys, exact opaque values, absent distinctions and historical snapshots', async () => {
    const f = await seed(), db = await fenceLegacyBusinessStores(f.name);
    expect(db.version).toBe(3); expect(db.name).toBe(f.name);
    for (const store of CAUSAL_BUSINESS_STORES) {
      expect(db.transaction(store).store.keyPath).toBe(BUSINESS_KEY_PATH);
      expect(await read(f.name, store)).toEqual(f.original);
      expect(await read(f.name, store, ['other', 2])).toBeNull();
      expect(await db.get(CAUSAL_BUSINESS_STORE, [store, 'present-undefined'])).toMatchObject({ present: true, value: undefined, cutover: { present: true, value: undefined } });
      expect(await db.get(CAUSAL_BUSINESS_STORE, [store, 'absent'])).toBeUndefined();
    }
    expect(await db.count(CAUSAL_BUSINESS_STORE)).toBe(CAUSAL_BUSINESS_STORES.length * 3);
    expect(await db.get('snapshots', 'historical')).toEqual(f.original);
    expect((await db.get(CAUSAL_STORE, 'account')).trackingValue).toEqual({ planViewCount: 27 }); db.close();
  });
  it('rejects reopened legacy explicit-key puts and retains authority after every legacy delete/clear', async () => {
    const f = await seed(); (await fenceLegacyBusinessStores(f.name)).close();
    const old = await openDB(f.name);
    for (const store of CAUSAL_BUSINESS_STORES) {
      await expect(old.put(store, { overwritten: true }, 'account')).rejects.toMatchObject({ name: 'DataError' });
      await old.delete(store, 'account'); await old.clear(store);
      expect(await read(f.name, store)).toEqual(f.original);
    }
    old.close(); (await fenceLegacyBusinessStores(f.name)).close();
    expect(await read(f.name, 'tasks')).toEqual(f.original);
  });
  it.each(CAUSAL_BUSINESS_STORES)('rolls back the entire migration when %s mirror copying fails', async store => {
    const f = await seed(), add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === store) throw new Error('Synthetic copy failure'); return add.apply(this, args);
    });
    await expect(fenceLegacyBusinessStores(f.name)).rejects.toThrow('Synthetic copy failure'); vi.restoreAllMocks();
    const db = await openDB(f.name); expect(db.version).toBe(2); expect(db.objectStoreNames.contains(CAUSAL_BUSINESS_STORE)).toBe(false);
    for (const name of CAUSAL_BUSINESS_STORES) {
      expect(db.transaction(name).store.keyPath).toBeNull(); expect(await db.get(name, 'account')).toEqual(f.original);
    }
    db.close();
  });
  it('serializes concurrent cutover and does not recopy modified mirrors on retry', async () => {
    const f = await seed(), results = await Promise.all([fenceLegacyBusinessStores(f.name), fenceLegacyBusinessStores(f.name)]);
    for (const db of results) { expect(db.version).toBe(3); db.close(); }
    const db = await openDB(f.name); await db.clear('tasks'); db.close();
    (await fenceLegacyBusinessStores(f.name)).close(); expect(await read(f.name, 'tasks')).toEqual(f.original);
  });
  it('commits authority with mirrors, retains cutover preimages on updates/deletes, and records new account absence', async () => {
    const f = await seed(), db = await fenceLegacyBusinessStores(f.name);
    const tx = db.transaction(causalBusinessTransactionStores(db, ['tasks', 'sync']), 'readwrite');
    await writeCausalBusiness(tx, 'tasks', 'account', ['new']);
    await writeCausalBusiness(tx, 'sync', 'account', undefined, false);
    await writeCausalBusiness(tx, 'tasks', 'new-account', ['new account']); await tx.done;
    expect(await read(f.name, 'tasks')).toEqual(['new']); expect(await read(f.name, 'sync')).toBeUndefined();
    expect((await db.get(CAUSAL_BUSINESS_STORE, ['tasks', 'account'])).cutover.value).toEqual(f.original);
    expect((await db.get(CAUSAL_BUSINESS_STORE, ['sync', 'account'])).cutover.value).toEqual(f.original);
    expect((await db.get(CAUSAL_BUSINESS_STORE, ['tasks', 'new-account'])).cutover.present).toBe(false);
    expect(await db.get('tasks', 'account')).toEqual({ [BUSINESS_KEY_PATH]: 'account', payload: ['new'] }); db.close();
  });
  it('does not commit a partial authoritative write when the final mirror write fails', async () => {
    const f = await seed(), db = await fenceLegacyBusinessStores(f.name), put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
      if (this.name === 'sync') throw new Error('Synthetic final write failure'); return put.apply(this, args);
    });
    const tx = db.transaction(causalBusinessTransactionStores(db, ['tasks', 'sync']), 'readwrite'); void tx.done.catch(() => undefined);
    await writeCausalBusiness(tx, 'tasks', 'account', ['new']);
    await expect(writeCausalBusiness(tx, 'sync', 'account', { cursor: 999 })).rejects.toThrow('Synthetic final write failure');
    tx.abort(); await expect(tx.done).rejects.toBeDefined(); vi.restoreAllMocks(); db.close();
    expect(await read(f.name, 'tasks')).toEqual(f.original); expect(await read(f.name, 'sync')).toEqual(f.original);
  });
  it('fails closed when authority is omitted or a partially fenced schema is encountered', async () => {
    const f = await seed(), db = await fenceLegacyBusinessStores(f.name);
    await expect(readCausalBusiness(db.transaction(['tasks']), 'tasks', 'account')).rejects.toThrow('included in the transaction');
    db.close();
    const damaged = await openDB(f.name, 4, { upgrade(db) { db.deleteObjectStore('tasks'); db.createObjectStore('tasks'); } }); damaged.close();
    await expect(fenceLegacyBusinessStores(f.name)).rejects.toThrow('Incompatible business storage schema');
    const remaining = await openDB(f.name); expect((await remaining.get(CAUSAL_BUSINESS_STORE, ['tasks', 'account'])).value).toEqual(f.original); remaining.close();
  });
});
