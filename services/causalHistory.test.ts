import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { CAUSAL_STORE } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { bindCausalCapability } from './causalEnrollment';
import { pullCausalHistory, fetchCausalHistoryChunk, validateSavedCausalHistory } from './causalHistory';
import { causalHistoryHash, CAUSAL_HISTORY_CHUNK_BYTES } from './causalHistoryProtocol';
import { encodeCausalBackup, decodeCausalBackup } from './causalBackup';
import { storageService, STORES } from './storage';

async function fixture(projectionRevision = 1) {
  const name = `s2-history-${crypto.randomUUID()}`, accountId = crypto.randomUUID(), epoch = crypto.randomUUID();
  const tracking = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, future: '🧭'.repeat(18000), ...JSON.parse('{"__proto__":{"retained":true}}') };
  const baseline = { schemaVersion: 1 as const, baselineId: epoch, accountId, day: tracking.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [epoch] };
  const db = await openDB(name, 1, { upgrade(db) { for (const store of Object.values(STORES)) db.createObjectStore(store); } });
  await db.put('tracking', tracking, accountId); await db.put('sync', { cursor: 7 }, accountId); await db.put('tasks', [{ id: 'synthetic', notes: 'retained' }], accountId); db.close();
  const event = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId, actorId: 'tab', day: tracking.date, timeZone: 'UTC', counter: 'planViewCount' as const, delta: 1, capturedAt: '2026-09-08T10:00:00.000Z', businessActionId: null, correctionOf: null };
  await admitLocalCounter(name, event, baseline);
  const capability = { schemaVersion: 2, accountId, enrolled: true, epoch, projectionRevision, rolloutReady: false };
  await bindCausalCapability(name, accountId, capability);
  const record = { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 1, server_version: 7, device_id: 'fixture', updated_at: '2026-09-08T00:00:00.123456+00:00', deleted_at: null, payload: tracking };
  const cutover = { schemaVersion: 2, accountId, epoch, revision: 0, receipt: { schemaVersion: 2, epoch, projectionRevision: 0, baseline,
    operation: { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 7, expectedTrackingPayload: tracking }, record } };
  const action = { schemaVersion: 2, accountId, epoch, revision: 1, receipt: { schemaVersion: 2, epoch, projectionRevision: 1, accepted: true,
    operation: { schemaVersion: 2, epoch, type: 'counter', command: event },
    outcome: { accepted: true, code: 'APPLIED', day: tracking.date, counts: { planViewCount: 28, dailyPostponeCount: 3 } },
    record: { ...record, server_version: 8, payload: { ...tracking, planViewCount: 28 } } } };
  const entries = [cutover, action]; const requests: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://synthetic'); requests.push(url.search);
    const revision = Number(url.searchParams.get('revision')), offset = Number(url.searchParams.get('offset'));
    const body = new TextEncoder().encode(JSON.stringify(entries[revision]));
    const part = body.slice(offset, offset + CAUSAL_HISTORY_CHUNK_BYTES);
    return Response.json({ schemaVersion: 2, accountId, epoch, revision, throughRevision: Number(url.searchParams.get('throughRevision')),
      offset, totalBytes: body.length, sha256: await causalHistoryHash(body), chunkSha256: await causalHistoryHash(part),
      data: Buffer.from(part).toString('base64'), nextOffset: offset + part.length < body.length ? offset + part.length : null });
  };
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId); db.close(); return state; };
  return { name, accountId, epoch, tracking, baseline, event, capability, entries, requests, fetch, read };
}

it('resumes exact saved byte offsets, archives complete receipts and leaves local projection/outbox/cursor intact', async () => {
  const f = await fixture(), before = await f.read();
  const first = await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }, 1);
  expect(first).toMatchObject({ complete: false, downloadedRevision: -1, fetched: 1 });
  const partial = (await f.read()).causalHistory;
  expect(partial.partial.chunks[0].nextOffset).toBe(CAUSAL_HISTORY_CHUNK_BYTES);
  expect(decodeCausalBackup(encodeCausalBackup(partial))).toEqual(partial);
  const result = await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch });
  expect(result.complete).toBe(true);
  expect(f.requests[1]).toContain(`offset=${CAUSAL_HISTORY_CHUNK_BYTES}`);
  const { causalHistory, ...after } = await f.read(); expect(after).toEqual(before);
  expect(causalHistory.downloadedRevision).toBe(1); expect(causalHistory.partial).toBeUndefined();
  for (let i = 0; i <= 1; i++) expect(JSON.parse(causalHistory.entries[i].body)).toEqual(f.entries[i]);
  const fetch = vi.fn(); expect((await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: fetch })).fetched).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
  const db = await openDB(f.name); expect(await db.get('sync', f.accountId)).toEqual({ cursor: 7 });
  expect(await db.get('tasks', f.accountId)).toEqual([{ id: 'synthetic', notes: 'retained' }]); db.close();
});

it('keeps retained progress on network failure and storage rollback, then retries the same chunk', async () => {
  const f = await fixture(); await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }, 1);
  const before = await f.read();
  await expect(pullCausalHistory(f.name, f.accountId, { authenticatedFetch: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  expect(await f.read()).toEqual(before);
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE) throw new Error('Synthetic download commit failure');
    return put.apply(this, args);
  });
  try { await expect(pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch })).rejects.toThrow('Synthetic download'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  const retried = f.requests.at(-1);
  expect((await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch })).complete).toBe(true);
  expect(f.requests[2]).toBe(retried);
});

it('finishes the saved horizon before fetching newly discovered revisions', async () => {
  const f = await fixture(0);
  await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }, 1);
  await bindCausalCapability(f.name, f.accountId, { ...f.capability, projectionRevision: 1 });
  expect(await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch })).toMatchObject({ complete: false, downloadedRevision: 0, throughRevision: 0 });
  expect(f.requests.every(query => query.includes('throughRevision=0'))).toBe(true);
  expect((await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch })).complete).toBe(true);
  expect(f.requests.at(-1)).toContain('throughRevision=1');
  expect((await f.read()).causalHistory.entries['0']).toBeDefined();
});

it('preserves a concurrent local action and rejects a competing stale downloader commit', async () => {
  const f = await fixture(); let once = true;
  const fetch = async (input: RequestInfo | URL) => {
    if (once) { once = false; await admitLocalCounter(f.name, { ...f.event, actionId: crypto.randomUUID() }, f.baseline); }
    return f.fetch(input);
  };
  await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: fetch }, 1);
  expect((await f.read()).trackingValue.planViewCount).toBe(29);
  let release!: () => void; let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const stalled = pullCausalHistory(f.name, f.accountId, { authenticatedFetch: async input => { reached(); await gate; return f.fetch(input); } }, 1);
  const observed = stalled.catch(error => error);
  await entered;
  await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }); const winner = await f.read();
  release(); expect(await observed).toBeInstanceOf(Error); expect(await f.read()).toEqual(winner);
});

it('rejects corrupt imported history rather than trusting its cursor', async () => {
  const f = await fixture(); await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch });
  const state = await f.read(); delete state.causalHistory.entries['0'];
  const db = await openDB(f.name); await db.put(CAUSAL_STORE, state); db.close();
  const fetch = vi.fn(); await expect(pullCausalHistory(f.name, f.accountId, { authenticatedFetch: fetch })).rejects.toThrow('recovery');
  expect(fetch).not.toHaveBeenCalled(); expect(await f.read()).toEqual(state);
});

it('rejects altered manifests, oversized responses, cancellation and corrupt archived bytes', async () => {
  const f = await fixture(); await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }, 1); const before = await f.read();
  await expect(pullCausalHistory(f.name, f.accountId, { authenticatedFetch: async input => {
    const data = await (await f.fetch(input)).json(); return Response.json({ ...data, sha256: '0'.repeat(64) });
  } })).rejects.toThrow('manifest changed');
  expect(await f.read()).toEqual(before);
  const position = { epoch: f.epoch, revision: 0, throughRevision: 1, offset: 0 };
  await expect(fetchCausalHistoryChunk(f.accountId, position, { authenticatedFetch: async () => new Response('x'.repeat(74000)) })).rejects.toThrow();
  const controller = new AbortController(); controller.abort(); const fetch = vi.fn();
  await expect(pullCausalHistory(f.name, f.accountId, { authenticatedFetch: fetch, signal: controller.signal })).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }); const history = (await f.read()).causalHistory;
  history.entries['0'].body += ' ';
  await expect(validateSavedCausalHistory(f.accountId, history)).rejects.toThrow('recovery');
});

it('resumes a partial download after actual schema-5 export and fresh-account restore', async () => {
  const f = await fixture();
  const values = new Map<string, string>();
  const localStorage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  Object.assign(globalThis, { window: { localStorage, dispatchEvent: () => true }, localStorage });
  values.set('goalflow_active_database_v2', f.name);
  await pullCausalHistory(f.name, f.accountId, { authenticatedFetch: f.fetch }, 1);
  const partial = (await f.read()).causalHistory;
  const backup = JSON.parse(JSON.stringify(await storageService.exportBackup(f.accountId)));
  const target = `s2-history-restore-${crypto.randomUUID()}`;
  values.set('goalflow_active_database_v2', target);
  await storageService.importBackup(f.accountId, backup);
  const db = await openDB(target);
  expect((await db.get(CAUSAL_STORE, f.accountId)).causalHistory).toEqual(partial);
  expect((await pullCausalHistory(target, f.accountId, { authenticatedFetch: f.fetch })).complete).toBe(true);
  expect(f.requests[1]).toContain(`offset=${CAUSAL_HISTORY_CHUNK_BYTES}`);
  expect((await db.get(CAUSAL_STORE, f.accountId)).trackingValue.planViewCount).toBe(28);
  db.close();
});
