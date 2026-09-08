import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { storageService, STORES } from './storage';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { CAUSAL_BUSINESS_STORE, CAUSAL_BUSINESS_STORES, fenceLegacyBusinessStores,
  causalBusinessTransactionStores, readCausalBusinessBackup, writeCausalBusiness } from './causalBusinessStorage';
import { encodeCausalBackup, decodeCausalBackup } from './causalBackup';
import { emptySyncMeta } from './syncProtocol';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function useDatabase(name: string) {
  const values = new Map<string, string>([['goalflow_active_database_v2', name]]);
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  vi.stubGlobal('window', { localStorage, dispatchEvent: () => true }); vi.stubGlobal('localStorage', localStorage);
  return values;
}
async function seed(fenced = true, account = 'synthetic-owner') {
  const name = `s2-business-backup-${crypto.randomUUID()}`;
  const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  const task = { id: 'task', completed: false, description: 'synthetic 🧭 notes', missing: undefined, future: JSON.parse('{"__proto__":{"retained":true}}') };
  await db.put('tasks', [task], account);
  await db.put('tracking', { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3 }, account);
  await db.put('sync', { ...emptySyncMeta(), cursor: 19, future: { exactRequest: '{ "timestamp": "2026-09-08T00:00:00.123456789Z" }' } }, account);
  await db.put('habits', null, account);
  await db.put('goals', undefined, account);
  await db.put('stats', { original: true }, account); db.close();
  (await fenceLegacyTracking(name)).close();
  if (fenced) (await fenceLegacyBusinessStores(name)).close();
  return { name, account, task };
}
async function evidence(name: string, account: string) {
  const db = await openDB(name);
  const tx = db.transaction([CAUSAL_BUSINESS_STORE, ...CAUSAL_BUSINESS_STORES]);
  const value = await readCausalBusinessBackup(tx, account); await tx.done; db.close(); return value;
}
async function rewriteBackup(backup: any, change: (evidence: any, backup: any) => void) {
  const result = structuredClone(backup), decoded = decodeCausalBackup(result.collections[CAUSAL_STORE].encoded);
  change(decoded, result); result.collections[CAUSAL_STORE].encoded = encodeCausalBackup(decoded);
  const canonical = JSON.stringify(result.collections, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  result.checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))), x => x.toString(16).padStart(2, '0')).join('');
  return result;
}
it('round trips exact business authority, absent markers, unknown fields and mirror discrepancies through the actual service', async () => {
  const f = await seed(), values = useDatabase(f.name), db = await openDB(f.name);
  const original = await db.get(CAUSAL_BUSINESS_STORE, ['tasks', f.account]); original.future = { retained: undefined };
  await db.put(CAUSAL_BUSINESS_STORE, original);
  const tx = db.transaction(causalBusinessTransactionStores(db, ['tasks', 'stats']), 'readwrite');
  await writeCausalBusiness(tx, 'tasks', f.account, [{ ...f.task, description: 'new synthetic final notes' }]);
  await writeCausalBusiness(tx, 'stats', f.account, { removedValue: true }, false); await tx.done;
  await db.clear('tasks'); db.close(); // Supported old code erases a mirror only.
  const wal = `goalflow_wal_v2_${encodeURIComponent(f.account)}_late`, raw = '{ "synthetic": "late captured intent" }';
  values.set(wal, raw);
  const before = await evidence(f.name, f.account), backup = await storageService.exportBackup(f.account);
  expect(backup.schemaVersion).toBe(6); expect(backup.collections.tasks[0].description).toBe('new synthetic final notes');
  expect(backup.collections.stats).toBeUndefined();
  const wire = JSON.parse(JSON.stringify(backup)), target = `s2-business-restore-${crypto.randomUUID()}`;
  const targetValues = useDatabase(target); await storageService.importBackup(f.account, wire);
  const after = await evidence(target, f.account);
  expect(after.records).toEqual(before.records);
  expect(Object.hasOwn(after.records.tasks!.value as object[], '0')).toBe(true);
  expect(Object.hasOwn((after.records.tasks!.value as any[])[0], 'missing')).toBe(true);
  expect(after.records.goals!.present).toBe(true); expect(after.records.goals!.value).toBeUndefined();
  expect(after.records.stats!.present).toBe(false); expect(after.records.stats!.cutover.value).toEqual({ original: true });
  expect(after.records.tasks!.future).toEqual({ retained: undefined });
  const restored = await openDB(target), authority = await restored.get(CAUSAL_STORE, f.account);
  const retained = decodeCausalBackup(authority.restoredBackups[wire.checksum].collections[CAUSAL_STORE].encoded) as any;
  expect(retained.business.mirrors.tasks.present).toBe(false); expect(retained.captures[wal]).toBe(raw);
  expect(targetValues.has(wal)).toBe(false);
  const edit = restored.transaction(causalBusinessTransactionStores(restored, ['tasks']), 'readwrite');
  await writeCausalBusiness(edit, 'tasks', f.account, [{ ...f.task, description: 'later local edit' }]); await edit.done; restored.close();
  const latest = await evidence(target, f.account); await storageService.importBackup(f.account, wire);
  expect(await evidence(target, f.account)).toEqual(latest); // Same backup never rewinds later work.
});
it.each(['account', 'manifest', 'projection', 'sync', 'schema'])('rejects %s corruption before schema or account writes even with a recomputed checksum', async kind => {
  const f = await seed(); useDatabase(f.name); const original = await storageService.exportBackup(f.account);
  const corrupt = await rewriteBackup(original, (evidence, backup) => {
    if (kind === 'account') evidence.business.records.tasks.accountKey = 'different-account';
    if (kind === 'manifest') delete evidence.business.records.goals;
    if (kind === 'projection') backup.collections.tasks = [{ id: 'fabricated' }];
    if (kind === 'sync') evidence.sync.cursor = 999;
    if (kind === 'schema') backup.schemaVersion = 5;
  });
  const target = `s2-business-invalid-${crypto.randomUUID()}`, db = await openDB(target, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  db.close(); useDatabase(target);
  await expect(storageService.importBackup(f.account, corrupt)).rejects.toThrow();
  const unchanged = await openDB(target); expect(unchanged.version).toBe(1); expect(unchanged.objectStoreNames.contains(CAUSAL_STORE)).toBe(false);
  expect(await unchanged.count('tasks')).toBe(0); unchanged.close();
});
it('rolls back every restored member when the final business authority insert fails and resumes the same artifact', async () => {
  const f = await seed(); useDatabase(f.name); const backup = JSON.parse(JSON.stringify(await storageService.exportBackup(f.account)));
  const target = `s2-business-interrupted-${crypto.randomUUID()}`; useDatabase(target);
  const add = IDBObjectStore.prototype.add;
  vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_BUSINESS_STORE && (args[0] as any).storeName === 'sync') throw new Error('Synthetic last-record failure');
    return add.apply(this, args);
  });
  await expect(storageService.importBackup(f.account, backup)).rejects.toThrow('Synthetic last-record failure'); vi.restoreAllMocks();
  const db = await openDB(target); expect(await db.count(CAUSAL_BUSINESS_STORE)).toBe(0); expect(await db.count(CAUSAL_STORE)).toBe(0);
  for (const store of CAUSAL_BUSINESS_STORES) expect(await db.count(store)).toBe(0); db.close();
  await storageService.importBackup(f.account, backup);
  expect((await evidence(target, f.account)).records).toEqual((await evidence(f.name, f.account)).records);
});
it('detects preexisting private absent markers when mirrors and tracking are missing', async () => {
  const source = await seed(); useDatabase(source.name); const backup = await storageService.exportBackup(source.account);
  const target = await seed(true, 'different-account'); useDatabase(target.name);
  const db = await openDB(target.name), tx = db.transaction(causalBusinessTransactionStores(db, ['tasks']), 'readwrite');
  await writeCausalBusiness(tx, 'tasks', source.account, { original: 'retained' }, false); await tx.done; db.close();
  const before = await evidence(target.name, source.account);
  await expect(storageService.importBackup(source.account, backup)).rejects.toThrow('Existing business authority');
  expect(await evidence(target.name, source.account)).toEqual(before);
});
it('imports schema 5 into an empty account in an already fenced database without altering other accounts', async () => {
  const source = await seed(false); useDatabase(source.name); const backup = JSON.parse(JSON.stringify(await storageService.exportBackup(source.account)));
  expect(backup.schemaVersion).toBe(5);
  const target = await seed(true, 'different-account'), before = await evidence(target.name, target.account); useDatabase(target.name);
  await storageService.importBackup(source.account, backup);
  expect(await evidence(target.name, target.account)).toEqual(before);
  expect((await evidence(target.name, source.account)).records.tasks!.value).toEqual(backup.collections.tasks);
});
