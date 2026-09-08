import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { storageService as storage } from './storage';
import { normalizeSyncMeta } from './syncProtocol';

const fixture = () => {
  const bytes = new Map<string, string>();
  const events: Event[] = [];
  const name = `s2-recovery-${crypto.randomUUID()}`;
  bytes.set('goalflow_active_database_v2', name);
  const localStorage = {
    get length() { return bytes.size; }, key: (index: number) => [...bytes.keys()][index] ?? null,
    getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => { bytes.set(key, value); },
    removeItem: (key: string) => { bytes.delete(key); }
  };
  Object.assign(globalThis, { localStorage, window: { localStorage, dispatchEvent: (event: Event) => { events.push(event); return true; } } });
  return { bytes, events, name, user: crypto.randomUUID() };
};
const wal = (bytes: Map<string, string>) => [...bytes].filter(([key]) => key.startsWith('goalflow_wal'));

describe('explicit recovery dismissal', () => {
  it('dismisses a stale group as a whole, archives evidence and retires its WAL', async () => {
    const { bytes, name, user } = fixture();
    await storage.set('tasks', user, [], 'cloud');
    await storage.set('stats', user, { completed: 10 }, 'cloud');
    storage.stageLocalValues(user, [
      { storeName: 'tasks', previousValue: [], nextValue: [{ id: 'a', completed: true }] },
      { storeName: 'stats', previousValue: { completed: 0 }, nextValue: { completed: 1 } }
    ]);
    const staged = wal(bytes);
    expect(staged).toHaveLength(1);
    const [groupKey, groupRaw] = staged[0];
    storage.stageLocalValue('amalgam', user, undefined, 'independent note');
    const blocked = await storage.flushPendingLocalChanges(user);
    const ids = Object.keys(blocked.localState?.journal ?? {}).filter(id => blocked.localState?.blocked?.[id]);
    expect(ids).toHaveLength(2);
    expect(wal(bytes)).toHaveLength(0); // journaled groups retire their bytes
    // Simulate the crash window between archive commit and WAL removal.
    bytes.set(groupKey, groupRaw);
    const member = ids[0];
    const dismissed = await storage.dismissBlockedReview(user, member, 'superseded by the current plan');
    expect(Object.keys(dismissed.localState?.blocked ?? {})).toHaveLength(0);
    expect(Object.keys(dismissed.localState?.discardedReviews ?? {}).sort()).toEqual(ids.sort());
    expect(dismissed.localState?.discardedReviews?.[member]).toMatchObject({
      reason: 'superseded by the current plan'
    });
    expect(dismissed.localState?.discardedReviews?.[member].blocked).toMatch(/STALE_GROUP_INTENT/);
    expect(bytes.get(groupKey)).toBeUndefined();
    const db = await openDB(name);
    expect(await db.get('tasks', user)).toEqual([]);
    expect(await db.get('stats', user)).toEqual({ completed: 10 });
    expect(await db.get('amalgam', user)).toBe('independent note');
    // Retrying the dismissal is idempotent; the original archive is retained.
    const again = await storage.dismissBlockedReview(user, member, 'another reason');
    expect(again.localState?.discardedReviews?.[member].reason).toBe('superseded by the current plan');
    expect(wal(bytes)).toHaveLength(0);
  });

  it('dismisses a retired group through its retained envelope', async () => {
    const { bytes, user } = fixture();
    await storage.set('tasks', user, [], 'cloud');
    await storage.set('stats', user, { completed: 10 }, 'cloud');
    storage.stageLocalValues(user, [
      { storeName: 'tasks', previousValue: [], nextValue: [{ id: 'a', completed: true }] },
      { storeName: 'stats', previousValue: { completed: 0 }, nextValue: { completed: 1 } }
    ]);
    const blocked = await storage.flushPendingLocalChanges(user);
    const ids = Object.keys(blocked.localState?.blocked ?? {});
    expect(ids).toHaveLength(2);
    expect(wal(bytes)).toHaveLength(0);
    const dismissed = await storage.dismissBlockedReview(user, ids[0], 'reviewed after retirement');
    expect(Object.keys(dismissed.localState?.blocked ?? {})).toHaveLength(0);
    expect(Object.keys(dismissed.localState?.discardedReviews ?? {}).sort()).toEqual(ids.sort());
    expect(Object.keys(dismissed.localState?.groups ?? {})).toHaveLength(1); // envelope retained
  });

  it('lists blocked reviews and no rejected completions without a causal journal', async () => {
    const { user } = fixture();
    await storage.set('tasks', user, [], 'cloud');
    await storage.set('stats', user, { completed: 10 }, 'cloud');
    storage.stageLocalValues(user, [
      { storeName: 'tasks', previousValue: [], nextValue: [{ id: 'a', completed: true }] },
      { storeName: 'stats', previousValue: { completed: 0 }, nextValue: { completed: 1 } }
    ]);
    await storage.flushPendingLocalChanges(user);
    const list = await storage.listRecoveryReviews(user);
    expect(list.blocked).toHaveLength(2);
    expect(list.rejectedCompletions).toEqual([]);
    const [first] = list.blocked;
    await storage.dismissBlockedReview(user, first.id, 'reviewed');
    expect(await storage.listRecoveryReviews(user)).toEqual({ blocked: [], rejectedCompletions: [] });
  });

  it('refuses unknown, live and malformed dismissals without changing state', async () => {
    const { name, user } = fixture();
    await storage.set('tasks', user, [], 'cloud');
    storage.stageLocalValue('tasks', user, [], [{ id: 'live', title: 'live' }]);
    await expect(storage.dismissBlockedReview(user, 'missing', 'reason')).rejects.toThrow('not awaiting recovery');
    await expect(storage.dismissBlockedReview(user, 'missing', '  ')).rejects.toThrow('short reason');
    const live = Object.keys((await storage.flushPendingLocalChanges(user)).localState?.journal ?? {})[0];
    await expect(storage.dismissBlockedReview(user, live, 'reason')).rejects.toThrow('not awaiting recovery');
    const db = await openDB(name);
    expect(await db.get('tasks', user)).toEqual([{ id: 'live', title: 'live' }]);
  });

  it('round-trips discarded reviews through sync metadata validation', async () => {
    const { user } = fixture();
    await storage.set('tasks', user, [], 'cloud');
    storage.stageLocalValues(user, [
      { storeName: 'tasks', previousValue: [], nextValue: [{ id: 'a', completed: true }] },
      { storeName: 'stats', previousValue: { completed: 0 }, nextValue: { completed: 1 } }
    ]);
    await storage.set('stats', user, { completed: 10 }, 'cloud');
    const blocked = await storage.flushPendingLocalChanges(user);
    const id = Object.keys(blocked.localState?.blocked ?? {})[0];
    const dismissed = await storage.dismissBlockedReview(user, id, 'reviewed');
    const roundTripped = normalizeSyncMeta(JSON.parse(JSON.stringify(dismissed)));
    expect(roundTripped.localState?.discardedReviews?.[id].reason).toBe('reviewed');
    const damaged = structuredClone(dismissed) as any;
    damaged.localState.discardedReviews = 'not-a-record';
    expect(() => normalizeSyncMeta(damaged)).toThrow('damaged');
  });
});
