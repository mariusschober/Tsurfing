import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareReconciliation, verifyReconciliationChunkAck } from './reconciliationStaging';
import type { ReconciliationCandidate } from './syncProtocol';

const fixture = JSON.parse(readFileSync('tests/fixtures/s2/reconciliation-staging-v1.json', 'utf8'));
const body = fixture.bodyPrefix + fixture.bodyUnit.repeat(fixture.repetitions) + fixture.bodySuffix;

describe('complete reconciliation staging', () => {
  it('matches the shared byte/hash fixture without altering nanosecond timestamps or escaping', async () => {
    const upload = await prepareReconciliation(JSON.parse(body));
    expect(upload.body).toBe(body);
    expect(upload.manifest).toEqual(fixture.manifest);
    expect(upload.chunks.map(chunk => chunk.chunkSha256)).toEqual(fixture.chunkHashes);
    expect(Buffer.concat(upload.chunks.map(chunk => Buffer.from(chunk.data, 'base64'))).toString('utf8')).toBe(body);
    for (const chunk of upload.chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThanOrEqual(262144);
      // Even an encoder escaping every base64 slash cannot exceed the envelope.
      expect(2 * chunk.data.length + Buffer.byteLength(JSON.stringify({ ...chunk, data: '' }), 'utf8')).toBeLessThanOrEqual(262144);
      const ack = { staged: true, manifest: chunk.manifest, chunkIndex: chunk.chunkIndex, chunkSha256: chunk.chunkSha256 };
      verifyReconciliationChunkAck(chunk, ack);
      expect(() => verifyReconciliationChunkAck(chunk, { ...ack, chunkSha256: '0'.repeat(64) })).toThrow(/exact/);
    }
    expect(await prepareReconciliation(JSON.parse(body))).toEqual(upload);
  });
  it('stages histories beyond 1000 entries even when their bytes fit one request', async () => {
    const candidate = { conflictId: 'local', sourceMutationId: null, entityType: 'settings', entityId: 'singleton',
      localHistory: Array.from({ length: 1001 }, (_, index) => ({ mutationId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        version: 1, payload: null, updatedAt: '2026-09-07T00:00:00.000Z', deletedAt: null })) };
    const upload = await prepareReconciliation(candidate);
    expect(upload.manifest).not.toBeNull();
    expect(JSON.parse(upload.body).localHistory).toHaveLength(1001);
  });
  it('captures bytes before awaits and preserves over-limit candidates', async () => {
    const candidate = JSON.parse(body) as ReconciliationCandidate;
    const pending = prepareReconciliation(candidate);
    candidate.localHistory[0].payload = { changed: true };
    expect((await pending).body).toBe(body);
    const oversized = JSON.parse(body);
    oversized.localHistory[0].payload.notes = 'x'.repeat(4 * 1024 * 1024);
    const before = JSON.stringify(oversized);
    await expect(prepareReconciliation(oversized)).rejects.toThrow(/preserved/);
    expect(JSON.stringify(oversized)).toBe(before);
  });
});
