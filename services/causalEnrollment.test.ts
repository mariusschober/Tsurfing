import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { CAUSAL_STORE } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { bindCausalCapability, discoverCausalCapability } from './causalEnrollment';
import { fetchCausalCapability } from './causalCapability';
import { prepareCausalRequest } from './causalReceipts';

async function fixture() {
  const name = `s2-capability-${crypto.randomUUID()}`; const accountId = crypto.randomUUID();
  const baseline = { schemaVersion: 1 as const, baselineId: crypto.randomUUID(), accountId, day: '2026-09-08', counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [] };
  const db = await openDB(name, 1, { upgrade(db) { db.createObjectStore('tracking'); db.createObjectStore('sync'); } });
  await db.put('tracking', { date: baseline.day, ...baseline.counts }, accountId); db.close();
  const event = { schemaVersion: 1 as const, actionId: crypto.randomUUID(), accountId, actorId: 'tab', day: baseline.day, timeZone: 'UTC', counter: 'planViewCount' as const, delta: 1, capturedAt: '2026-09-08T10:00:00.000Z', businessActionId: null, correctionOf: null };
  await admitLocalCounter(name, event, baseline);
  const capability = { schemaVersion: 2, accountId, enrolled: true, epoch: crypto.randomUUID(), projectionRevision: 3, rolloutReady: false };
  const operation = { schemaVersion: 2, epoch: capability.epoch, type: 'counter', command: event };
  const read = async () => { const db = await openDB(name); const state = await db.get(CAUSAL_STORE, accountId); db.close(); return state; };
  return { name, accountId, capability, operation, read };
}

it('requires discovery before preparing wire bytes and preserves projection and generation', async () => {
  const f = await fixture(); const before = await f.read();
  await expect(prepareCausalRequest(f.name, f.accountId, f.operation)).rejects.toThrow('discovered account epoch');
  expect(await f.read()).toEqual(before);
  const fetch = vi.fn(async () => Response.json(f.capability));
  await discoverCausalCapability(f.name, f.accountId, { authenticatedFetch: fetch });
  const { causalCapability, ...after } = await f.read();
  expect(after).toEqual(before); expect(causalCapability).toEqual(f.capability);
  expect(fetch).toHaveBeenCalledWith('/api/v1/sync/causal-capability', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
  expect(await prepareCausalRequest(f.name, f.accountId, f.operation)).toBe(JSON.stringify(f.operation));
});

it('retains the prior binding and requests on stale epoch, revision, or account responses', async () => {
  const f = await fixture(); await bindCausalCapability(f.name, f.accountId, f.capability);
  await prepareCausalRequest(f.name, f.accountId, f.operation); const before = await f.read();
  for (const changed of [{ epoch: crypto.randomUUID() }, { projectionRevision: 2 }, { accountId: crypto.randomUUID() }, { rolloutReady: true }]) {
    await expect(bindCausalCapability(f.name, f.accountId, { ...f.capability, ...changed })).rejects.toThrow();
    expect(await f.read()).toEqual(before);
  }
  await bindCausalCapability(f.name, f.accountId, { ...f.capability, projectionRevision: 4 });
  expect((await f.read()).causalRequests).toEqual(before.causalRequests);
});

it('rolls back a failed binding and does not fence an unprepared database', async () => {
  const f = await fixture(); const before = await f.read(); const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE) throw new Error('Synthetic capability storage failure');
    return put.apply(this, args);
  });
  try { await expect(bindCausalCapability(f.name, f.accountId, f.capability)).rejects.toThrow('Synthetic capability'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  const name = `s2-unprepared-${crypto.randomUUID()}`;
  const db = await openDB(name, 1, { upgrade(db) { db.createObjectStore('tracking'); } }); db.close();
  await expect(bindCausalCapability(name, f.accountId, f.capability)).rejects.toThrow('Explicit local');
  const reopened = await openDB(name); expect(reopened.version).toBe(1); expect(reopened.objectStoreNames.contains(CAUSAL_STORE)).toBe(false); reopened.close();
});

it('binds historical attempted bytes only to their original epoch', async () => {
  const f = await fixture(); const state = await f.read();
  const bytes = JSON.stringify(f.operation, null, 2);
  state.causalRequests = { [f.operation.command.actionId]: bytes };
  const db = await openDB(f.name); await db.put(CAUSAL_STORE, state); db.close();
  await expect(bindCausalCapability(f.name, f.accountId, { ...f.capability, epoch: crypto.randomUUID() })).rejects.toThrow('immutable attempted request');
  expect(await f.read()).toEqual(state);
  await bindCausalCapability(f.name, f.accountId, f.capability);
  expect(await prepareCausalRequest(f.name, f.accountId, f.operation)).toBe(bytes);
});

it('handles absent enrollment and rejects oversized or cross-account discovery without writes', async () => {
  const f = await fixture(); const before = await f.read();
  const absent = { ...f.capability, enrolled: false, epoch: null, projectionRevision: null };
  expect(await discoverCausalCapability(f.name, f.accountId, { authenticatedFetch: async () => Response.json(absent) })).toEqual(absent);
  expect(await f.read()).toEqual(before);
  await expect(fetchCausalCapability(f.accountId, { authenticatedFetch: async () => Response.json({ ...f.capability, accountId: crypto.randomUUID() }) })).rejects.toThrow('authenticated account');
  await expect(fetchCausalCapability(f.accountId, { authenticatedFetch: async () => new Response('x'.repeat(17000)) })).rejects.toThrow();
  const controller = new AbortController(); controller.abort(); const fetch = vi.fn();
  await expect(fetchCausalCapability(f.accountId, { authenticatedFetch: fetch, signal: controller.signal })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
