import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { encodeCausalBackup, decodeCausalBackup } from './causalBackup';
import { CAUSAL_STORE, fenceLegacyTracking } from './causalStorage';
import { storageService, STORES } from './storage';

describe('causal backup preservation', () => {
  it('round trips undefined and unknown own fields without confusing user values with tags', () => {
    const original = { absent: undefined, nested: [undefined, ['undefined']], unknown: JSON.parse('{"__proto__":{"audit":true}}') };
    const restored = decodeCausalBackup(JSON.parse(JSON.stringify(encodeCausalBackup(original))));
    expect(restored).toEqual(original);
    expect(Object.hasOwn(restored as object, 'absent')).toBe(true);
    expect(Object.hasOwn((restored as any).unknown, '__proto__')).toBe(true);
    expect(() => decodeCausalBackup(['object', [['x', ['value', 1]], ['x', ['value', 2]]]])).toThrow('invalid');
  });

  it('rejects unsupported preimages instead of silently changing their meaning', () => {
    const cycle: any = {}; cycle.self = cycle;
    for (const value of [cycle, new Date(), NaN, -0, new Map(), BigInt(1), new Array(2)]) {
      expect(() => encodeCausalBackup(value)).toThrow();
    }
  });

  it('exports protected authority, exact wire evidence and late legacy captures without replaying them', async () => {
    const values = new Map<string, string>();
    const name = `s2-backup-${crypto.randomUUID()}`;
    values.set('goalflow_active_database_v2', name);
    const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    Object.assign(globalThis, { window: { localStorage, dispatchEvent: () => true }, localStorage });
    const account = 'synthetic-account';
    const tracking = { date: '2026-09-08', planViewCount: 28, dailyPostponeCount: 4 };
    await storageService.set(STORES.TRACKING, account, tracking, 'cloud');
    const legacyBackup = await storageService.exportBackup(account);
    const db = await fenceLegacyTracking(name);
    const state = await db.get(CAUSAL_STORE, account);
    state.causalRequests = { action: '{ "exact": "saved bytes" }' };
    state.causalReceipts = { action: { accepted: true, unknown: JSON.parse('{"__proto__":"retained"}') } };
    await db.put(CAUSAL_STORE, state);
    await db.delete(STORES.TRACKING, account); // Legacy deletion cannot erase authority.
    const walKey = `goalflow_wal_v2_${encodeURIComponent(account)}_late`;
    const raw = '{ "legacy": "uninterpreted late capture" }';
    values.set(walKey, raw);
    const backup = await storageService.exportBackup(account);
    expect(backup.schemaVersion).toBe(5);
    expect(backup.collections.tracking).toEqual(tracking);
    const envelope = JSON.parse(JSON.stringify(backup));
    const recovered = decodeCausalBackup(envelope.collections[CAUSAL_STORE].encoded) as any;
    expect(recovered.authority).toEqual(state);
    expect(recovered.captures[walKey]).toBe(raw);
    expect(recovered.trackingMirror).toBeUndefined();
    expect(values.get(walKey)).toBe(raw);
    await expect(storageService.importBackup(account, envelope)).rejects.toThrow('journal reconciliation');
    await expect(storageService.importBackup(account, legacyBackup)).rejects.toThrow('journal reconciliation');
    expect(await db.get(CAUSAL_STORE, account)).toEqual(state);
    expect(await db.get(STORES.TRACKING, account)).toBeUndefined();
    db.close();
  });
});
