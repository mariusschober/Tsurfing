import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

describe('S1 F: unavailable atomic storage', () => {
  it.each([false, true])('keeps cursor and exact offline WAL when optional mirror fails=%s', async mirrorFails => {
    vi.resetModules();
    const values = new Map<string, string>();
    const user = 'synthetic-fallback-user';
    const meta = JSON.stringify({ schemaVersion: 2, cursor: 7, versions: {}, outbox: [], conflicts: [] });
    values.set(`goalflow_fallback_sync_${user}`, meta);
    values.set(`goalflow_fallback_tracking_${user}`, JSON.stringify({ date: '2026-09-07', planViewCount: 0, dailyPostponeCount: 0 }));
    const localStorage = {
      get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => { if (mirrorFails && k.startsWith('goalflow_dr_')) throw new Error('synthetic mirror quota'); values.set(k, v); },
      removeItem: (k: string) => { values.delete(k); }
    };
    Object.assign(globalThis, { window: { localStorage, dispatchEvent: () => true }, localStorage });
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('synthetic IndexedDB unavailable'); });
    const { storageService } = await import('./storage');
    try {
      const original = JSON.parse(values.get(`goalflow_fallback_tracking_${user}`)!);
      storageService.stageLocalValue('tracking', user, original, { ...original, planViewCount: 1 });
      const wal = [...values.entries()].filter(([k]) => k.startsWith('goalflow_wal'));
      await expect(storageService.applyRemotePage(user, [{ entityType: 'tracking', entityId: 'singleton', version: 1,
        serverVersion: 8, payload: { ...original, planViewCount: 2 }, deviceId: 'peer', deletedAt: null }], 8, 'local')).rejects.toThrow(/atomically/);
      expect(values.get(`goalflow_fallback_sync_${user}`)).toBe(meta);
      expect([...values.entries()].filter(([k]) => k.startsWith('goalflow_wal'))).toEqual(wal);
      expect(JSON.parse(values.get(`goalflow_fallback_tracking_${user}`)!)).toEqual(original);
    } finally { open.mockRestore(); }
  });
});
