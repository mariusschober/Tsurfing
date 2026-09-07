import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { prepareReconciliation } from '../services/reconciliationStaging';
import { stageReconciliationChunk } from './reconciliationStaging';
import { reconcileCandidate } from './routes/sync';

const fixture = JSON.parse(readFileSync('tests/fixtures/s2/reconciliation-staging-v1.json', 'utf8'));
describe('reconciliation staging API boundary', () => {
  it('checks decoded bytes, per-chunk hash, manifest and account-bound RPC acknowledgment', async () => {
    const upload = await prepareReconciliation(JSON.parse(fixture.bodyPrefix + fixture.bodyUnit.repeat(fixture.repetitions) + fixture.bodySuffix));
    const chunk = upload.chunks[0];
    const rpc = vi.fn().mockResolvedValue({ data: { staged: true, manifest: chunk.manifest, chunkIndex: 0, chunkSha256: chunk.chunkSha256 }, error: null });
    const database = { rpc } as unknown as SupabaseClient;
    await stageReconciliationChunk(database, 'authenticated-user', chunk);
    expect(rpc).toHaveBeenCalledWith('goalflow_stage_reconciliation_chunk_v1', { target_user_id: 'authenticated-user', request: chunk });
    await expect(stageReconciliationChunk(database, 'authenticated-user', { ...chunk, chunkSha256: '0'.repeat(64) })).rejects.toThrow(/manifest/);
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({ data: { staged: true, ...chunk, chunkIndex: 1 }, error: null });
    await expect(stageReconciliationChunk(database, 'authenticated-user', chunk)).rejects.toThrow(/acknowledged/);
  });
  it('keeps the old history limit and requires exact whole-candidate receipts on the staged path', async () => {
    const candidate = { conflictId: 'local', sourceMutationId: null, entityType: 'settings', entityId: 'singleton',
      localHistory: Array.from({ length: 1001 }, (_, i) => ({ mutationId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        version: 1, payload: null, updatedAt: '2026-09-07T00:00:00.000Z', deletedAt: null })) };
    const reply = { reconciled: true, candidate, receiptId: '11111111-1111-4111-8111-111111111111', serverMissing: true, record: null };
    const rpc = vi.fn().mockResolvedValue({ data: reply, error: null });
    const database = { rpc } as unknown as SupabaseClient;
    await expect(reconcileCandidate(database, 'user', candidate)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
    const missingPayload: any = { ...candidate, localHistory: [{ ...candidate.localHistory[0] }] };
    delete missingPayload.localHistory[0].payload;
    await expect(reconcileCandidate(database, 'user', missingPayload, 100000)).rejects.toThrow(/payload/);
    expect(rpc).not.toHaveBeenCalled();
    expect(await reconcileCandidate(database, 'user', candidate, 100000)).toEqual(reply);
    rpc.mockResolvedValue({ data: { ...reply, candidate: { ...candidate, localHistory: candidate.localHistory.slice(1) } }, error: null });
    await expect(reconcileCandidate(database, 'user', candidate, 100000)).rejects.toThrow(/exact/);
  });
});
