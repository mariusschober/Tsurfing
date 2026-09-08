import { expect, it } from 'vitest';
import { assembleCausalHistoryEntry, assertCausalHistoryChunk, causalHistoryHash, CAUSAL_HISTORY_CHUNK_BYTES } from './causalHistoryProtocol';
const accountId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const position = { epoch, revision: 0, throughRevision: 1001, offset: 0 };

function cutover() {
  const payload = { date: '2026-09-08', planViewCount: 27, dailyPostponeCount: 3, focusSession: null, notes: '🧭'.repeat(20000), ...JSON.parse('{"__proto__":{"retained":true}}') };
  const operation = { schemaVersion: 2, accountId, cutoverId: epoch, expectedTrackingServerVersion: 7, expectedTrackingPayload: payload };
  return { schemaVersion: 2, accountId, epoch, revision: 0, receipt: { schemaVersion: 2, operation, epoch, projectionRevision: 0,
    baseline: { schemaVersion: 1, accountId, baselineId: epoch, day: payload.date, counts: { planViewCount: 27, dailyPostponeCount: 3 }, evidenceIds: [epoch] },
    record: { user_id: accountId, entity_type: 'tracking', entity_id: 'singleton', version: 2, server_version: 7, device_id: 'fixture', updated_at: '2026-09-08T00:00:00.123456+00:00', deleted_at: null, payload } } };
}
async function chunks(entry: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(entry)); const sha256 = await causalHistoryHash(bytes); const result = [];
  for (let offset = 0; offset < bytes.length; offset += CAUSAL_HISTORY_CHUNK_BYTES) {
    const part = bytes.slice(offset, offset + CAUSAL_HISTORY_CHUNK_BYTES);
    result.push({ schemaVersion: 2, accountId, ...position, offset, totalBytes: bytes.length, sha256, chunkSha256: await causalHistoryHash(part), data: Buffer.from(part).toString('base64'), nextOffset: offset + part.length < bytes.length ? offset + part.length : null });
  }
  return result;
}
it('reassembles exact UTF-8 cutover evidence across byte boundaries and preserves unknown fields', async () => {
  const entry = cutover(); const parts = await chunks(entry);
  expect(parts.length).toBeGreaterThan(1);
  expect((await assembleCausalHistoryEntry(accountId, position, parts)).entry).toEqual(entry);
  expect(JSON.parse((await assembleCausalHistoryEntry(accountId, position, parts)).body).receipt.record.payload.__proto__).toEqual({ retained: true });
});
it('rejects missing, reordered, substituted or corrupted chunks before accepting a history entry', async () => {
  const parts = await chunks(cutover());
  for (const invalid of [parts.slice(1), [...parts].reverse(), [...parts, parts[0]], parts.slice(0, -1), [{ ...parts[0], sha256: '0'.repeat(64) }, ...parts.slice(1)]]) {
    await expect(assembleCausalHistoryEntry(accountId, position, invalid)).rejects.toThrow();
  }
  for (const altered of [{ accountId: epoch }, { epoch: accountId }, { revision: 1 }, { throughRevision: 1002 }, { offset: 1 }, { nextOffset: null }, { data: 'AAAA' }, { chunkSha256: '0'.repeat(64) }]) {
    await expect(assertCausalHistoryChunk(accountId, position, { ...parts[0], ...altered })).rejects.toThrow();
  }
});
it('rejects altered cutover counters or receipt identity even with valid transport hashes', async () => {
  const entry = cutover(); entry.receipt.baseline.counts.planViewCount = 28;
  await expect(assembleCausalHistoryEntry(accountId, position, await chunks(entry))).rejects.toThrow('cutover baseline');
  entry.receipt.baseline.counts.planViewCount = 27; entry.receipt.record.user_id = epoch;
  await expect(assembleCausalHistoryEntry(accountId, position, await chunks(entry))).rejects.toThrow('cutover baseline');
});

it('requires an exact action receipt at its declared history revision', async () => {
  const entry: any = cutover(); entry.revision = 1;
  entry.receipt.operation = { schemaVersion: 2, epoch, type: 'counter', command: { schemaVersion: 1,
    actionId: '33333333-3333-4333-8333-333333333333', accountId, actorId: 'fixture', day: '2026-09-08', timeZone: 'UTC', counter: 'planViewCount', delta: 1,
    capturedAt: '2026-09-08T00:00:00.000Z', businessActionId: null, correctionOf: null } };
  entry.receipt.projectionRevision = 1; entry.receipt.accepted = true;
  entry.receipt.outcome = { accepted: true, code: 'APPLIED', day: '2026-09-08', counts: { planViewCount: 28, dailyPostponeCount: 3 } };
  entry.receipt.record.payload.planViewCount = 28;
  const atAction = { ...position, revision: 1 };
  const parts = (await chunks(entry)).map(part => ({ ...part, revision: 1 }));
  expect((await assembleCausalHistoryEntry(accountId, atAction, parts)).entry).toEqual(entry);
  entry.receipt.projectionRevision = 2;
  await expect(assembleCausalHistoryEntry(accountId, atAction, (await chunks(entry)).map(part => ({ ...part, revision: 1 })))).rejects.toThrow('different revision');
});
