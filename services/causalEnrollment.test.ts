import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { IDBObjectStore } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import { CAUSAL_STORE } from './causalStorage';
import { admitLocalCounter } from './causalCounterCoordinator';
import { bindCausalCapability, discoverCausalCapability, prepareCausalCutover, commitCausalCutoverReceipt, syncCausalCutover } from './causalEnrollment';
import { sendCausalCutover } from './causalCutoverTransport';
import { encodeCausalBackup, readCausalBackup } from './causalBackup';
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

async function cutoverFixture() {
  const f = await fixture();
  const before = await f.read();
  const operation = { schemaVersion: 2, accountId: f.accountId, cutoverId: f.capability.epoch,
    expectedTrackingServerVersion: 7, expectedTrackingPayload: before.cutover.trackingValue };
  const receipt = { schemaVersion: 2, operation, epoch: operation.cutoverId, projectionRevision: 0,
    record: { user_id: f.accountId, entity_type: 'tracking', entity_id: 'singleton', version: 1,
      server_version: 7, device_id: 'test', updated_at: '2026-09-08T10:00:00.000Z', deleted_at: null,
      payload: operation.expectedTrackingPayload },
    baseline: { schemaVersion: 1, baselineId: operation.cutoverId, accountId: f.accountId,
      day: operation.expectedTrackingPayload.date, counts: { planViewCount: 27, dailyPostponeCount: 3 },
      evidenceIds: [operation.cutoverId] } };
  return { ...f, before, cutoverOperation: operation, receipt };
}

it('retains cutover bytes and exact receipt across retries without changing pending projections', async () => {
  const f = await cutoverFixture();
  const bytes = await prepareCausalCutover(f.name, f.accountId, f.cutoverOperation);
  expect(bytes).toBe(JSON.stringify(f.cutoverOperation));
  expect(await prepareCausalCutover(f.name, f.accountId, f.cutoverOperation)).toBe(bytes);
  expect(await commitCausalCutoverReceipt(f.name, f.accountId, f.receipt)).toEqual({ duplicate: false });
  expect(await commitCausalCutoverReceipt(f.name, f.accountId, f.receipt)).toEqual({ duplicate: true });
  const { cutoverRequest, cutoverReceipt, ...unchanged } = await f.read();
  expect(unchanged).toEqual(f.before);
  expect(cutoverRequest).toBe(bytes); expect(cutoverReceipt).toEqual(f.receipt);
  await expect(bindCausalCapability(f.name, f.accountId, { ...f.capability, epoch: crypto.randomUUID() })).rejects.toThrow('immutable cutover request');
  await bindCausalCapability(f.name, f.accountId, f.capability);
});

it('refuses baseline invention, replacement cutover identities and unattempted receipts', async () => {
  const f = await cutoverFixture();
  await expect(commitCausalCutoverReceipt(f.name, f.accountId, f.receipt)).rejects.toThrow('exact attempted cutover');
  await expect(prepareCausalCutover(f.name, f.accountId, { ...f.cutoverOperation,
    expectedTrackingPayload: { ...f.cutoverOperation.expectedTrackingPayload, planViewCount: 28 } })).rejects.toThrow('preserved local baseline');
  expect(await f.read()).toEqual(f.before);
  await prepareCausalCutover(f.name, f.accountId, f.cutoverOperation);
  const saved = await f.read();
  await expect(prepareCausalCutover(f.name, f.accountId, { ...f.cutoverOperation, cutoverId: crypto.randomUUID() })).rejects.toThrow('immutable');
  await expect(commitCausalCutoverReceipt(f.name, f.accountId, { ...f.receipt, projectionRevision: 1 })).rejects.toThrow();
  expect(await f.read()).toEqual(saved);
});

it('rolls back enrollment storage failure and preserves previously formatted attempted bytes', async () => {
  const f = await cutoverFixture();
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE) throw new Error('Synthetic enrollment storage failure');
    return put.apply(this, args);
  });
  try { await expect(prepareCausalCutover(f.name, f.accountId, f.cutoverOperation)).rejects.toThrow('Synthetic enrollment'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(f.before);
  const bytes = JSON.stringify(f.cutoverOperation, null, 2);
  const db = await openDB(f.name); await db.put(CAUSAL_STORE, { ...f.before, cutoverRequest: bytes }); db.close();
  expect(await prepareCausalCutover(f.name, f.accountId, f.cutoverOperation)).toBe(bytes);
});

it('retries a lost enrollment response with the original bytes and stops sending after durable proof', async () => {
  const f = await cutoverFixture();
  const fetch = vi.fn(async (_path: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.body).toBe((await f.read()).cutoverRequest);
    if (fetch.mock.calls.length === 1) throw new Error('Synthetic lost cutover response');
    return Response.json(f.receipt);
  });
  await expect(syncCausalCutover(f.name, f.accountId, f.cutoverOperation, { authenticatedFetch: fetch })).rejects.toThrow('Synthetic lost');
  const saved = await f.read();
  expect(saved.cutoverReceipt).toBeUndefined();
  expect(saved.trackingValue).toEqual(f.before.trackingValue);
  expect(await syncCausalCutover(f.name, f.accountId, f.cutoverOperation, { authenticatedFetch: fetch })).toEqual({ duplicate: false });
  expect(await syncCausalCutover(f.name, f.accountId, f.cutoverOperation, { authenticatedFetch: fetch })).toEqual({ duplicate: true });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0][1]?.body).toBe(fetch.mock.calls[1][1]?.body);
});

it('stages a large multibyte baseline and validates every chunk before accepting enrollment', async () => {
  const f = await cutoverFixture();
  f.cutoverOperation.expectedTrackingPayload.future = '🧭'.repeat(70000);
  const bytes = JSON.stringify(f.cutoverOperation);
  const chunks: any[] = [];
  const fetch = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string);
    if (path === '/api/v1/sync/conflicts/stage') {
      chunks.push(body);
      return Response.json({ staged: true, manifest: body.manifest, chunkIndex: body.chunkIndex, chunkSha256: body.chunkSha256 });
    }
    expect(path).toBe('/api/v1/sync/causal-cutover-staged');
    expect(body).toEqual(chunks[0].manifest);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString('utf8')).toBe(bytes);
    return Response.json(f.receipt);
  });
  expect(await sendCausalCutover(f.accountId, bytes, { authenticatedFetch: fetch })).toEqual(f.receipt);
  expect(chunks.length).toBeGreaterThan(1);
  const corrupt = vi.fn(async () => Response.json({ staged: true }));
  await expect(sendCausalCutover(f.accountId, bytes, { authenticatedFetch: corrupt })).rejects.toThrow('exact chunk');
  expect(corrupt).toHaveBeenCalledTimes(1);
});

it('validates retained enrollment proof before a backup can be restored', async () => {
  const f = await cutoverFixture();
  await prepareCausalCutover(f.name, f.accountId, f.cutoverOperation);
  await commitCausalCutoverReceipt(f.name, f.accountId, f.receipt);
  const evidence = { authority: await f.read(), trackingMirror: undefined, sync: undefined, captures: {} };
  const backup = () => ({ schemaVersion: 1, encoded: encodeCausalBackup(evidence) });
  expect(readCausalBackup(f.accountId, backup()).authority).toEqual(evidence.authority);
  evidence.authority.cutoverReceipt.projectionRevision = 1;
  expect(() => readCausalBackup(f.accountId, backup())).toThrow();
  evidence.authority.cutoverReceipt = f.receipt;
  delete evidence.authority.cutoverRequest;
  expect(() => readCausalBackup(f.accountId, backup())).toThrow('exact attempted cutover');
});

it('serializes competing cutover identities and retries a failed receipt commit without losing its request', async () => {
  const f = await cutoverFixture();
  const results = await Promise.allSettled([
    prepareCausalCutover(f.name, f.accountId, f.cutoverOperation),
    prepareCausalCutover(f.name, f.accountId, { ...f.cutoverOperation, cutoverId: crypto.randomUUID() })
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  const before = await f.read();
  const operation = JSON.parse(before.cutoverRequest);
  const receipt = { ...f.receipt, operation, epoch: operation.cutoverId,
    baseline: { ...f.receipt.baseline, baselineId: operation.cutoverId, evidenceIds: [operation.cutoverId] } };
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, ...args) {
    if (this.name === CAUSAL_STORE && args[0]?.cutoverReceipt) throw new Error('Synthetic receipt commit failure');
    return put.apply(this, args);
  });
  try { await expect(commitCausalCutoverReceipt(f.name, f.accountId, receipt)).rejects.toThrow('Synthetic receipt'); }
  finally { spy.mockRestore(); }
  expect(await f.read()).toEqual(before);
  expect(await commitCausalCutoverReceipt(f.name, f.accountId, receipt)).toEqual({ duplicate: false });
  expect((await f.read()).cutoverRequest).toBe(before.cutoverRequest);
});

it('retains an oversized baseline without admitting an unsendable new enrollment', async () => {
  const f = await cutoverFixture();
  const baseline = { ...f.cutoverOperation.expectedTrackingPayload, future: '🧭'.repeat(1048576) };
  const db = await openDB(f.name);
  const state = await db.get(CAUSAL_STORE, f.accountId);
  state.cutover.trackingValue = baseline;
  await db.put(CAUSAL_STORE, state); db.close();
  await expect(prepareCausalCutover(f.name, f.accountId, { ...f.cutoverOperation,
    expectedTrackingPayload: baseline })).rejects.toThrow('4 MiB enrollment envelope');
  expect(await f.read()).toEqual(state);
});
