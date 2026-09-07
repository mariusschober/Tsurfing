import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const reconciliationManifest = z.object({
  schemaVersion: z.literal(1), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  totalBytes: z.number().int().min(1).max(4 * 1024 * 1024),
  chunkCount: z.number().int().min(1).max(64),
  chunkHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1).max(64)
}).strict().refine(value => value.chunkCount === Math.ceil(value.totalBytes / 65536) && value.chunkHashes.length === value.chunkCount);
const chunkRequest = z.object({
  manifest: reconciliationManifest,
  chunkIndex: z.number().int().min(0).max(63),
  chunkSha256: z.string().regex(/^[0-9a-f]{64}$/),
  data: z.string().min(4).max(87384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
}).strict();

export async function stageReconciliationChunk(database: SupabaseClient, userId: string, input: unknown) {
  const request = chunkRequest.parse(input);
  const bytes = Buffer.from(request.data, 'base64');
  if (request.chunkIndex >= request.manifest.chunkCount
    || bytes.length !== Math.min(65536, request.manifest.totalBytes - request.chunkIndex * 65536)
    || bytes.toString('base64') !== request.data
    || request.manifest.chunkHashes[request.chunkIndex] !== request.chunkSha256
    || createHash('sha256').update(bytes).digest('hex') !== request.chunkSha256) {
    throw new z.ZodError([{ code: 'custom', path: ['data'], message: 'Reconciliation chunk does not match its manifest.' }]);
  }
  const { data, error } = await database.rpc('goalflow_stage_reconciliation_chunk_v1', { target_user_id: userId, request });
  if (error) throw error;
  const expected = { staged: true, manifest: request.manifest, chunkIndex: request.chunkIndex, chunkSha256: request.chunkSha256 };
  if (!data || data.staged !== true || data.chunkIndex !== expected.chunkIndex || data.chunkSha256 !== expected.chunkSha256
    || !reconciliationManifest.safeParse(data.manifest).success
    || Object.keys(expected.manifest).some(key => JSON.stringify(data.manifest[key]) !== JSON.stringify(expected.manifest[key as keyof typeof expected.manifest]))) {
    throw new Error('Reconciliation chunk was not acknowledged exactly.');
  }
  return data;
}

export async function readStagedReconciliation(database: SupabaseClient, userId: string, input: unknown) {
  const manifest = reconciliationManifest.parse(input);
  const { data, error } = await database.rpc('goalflow_read_staged_reconciliation_v1', {
    target_user_id: userId, target_manifest: manifest
  });
  if (error) throw error;
  return data;
}
