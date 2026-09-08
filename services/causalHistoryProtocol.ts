import { z } from 'zod';
import { assertCausalReceipt, parseCausalOperation } from './causalProtocol';
import { validateCounterBaseline } from '../src/domain/counterLedger';
import { stableJson } from './syncProtocol';
import { assertCausalCompletionReceipt, parseCausalCompletion } from './causalCompletionProtocol';

export const CAUSAL_HISTORY_CHUNK_BYTES = 49152;
/** Per entry, not a limit on the number of retained action revisions. */
export const MAX_CAUSAL_HISTORY_ENTRY_BYTES = 16 * 1024 * 1024;
const uuid = z.string().uuid();
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const causalHistoryPosition = z.object({ epoch: uuid, revision: integer, throughRevision: integer,
  offset: integer.max(MAX_CAUSAL_HISTORY_ENTRY_BYTES).multipleOf(CAUSAL_HISTORY_CHUNK_BYTES) }).strict()
  .refine(value => value.revision <= value.throughRevision);
export type CausalHistoryPosition = z.infer<typeof causalHistoryPosition>;
const chunkSchema = z.object({ schemaVersion: z.literal(2), accountId: uuid, epoch: uuid,
  revision: integer, throughRevision: integer, offset: integer, totalBytes: integer.min(1).max(MAX_CAUSAL_HISTORY_ENTRY_BYTES),
  sha256: sha, chunkSha256: sha, data: z.string().max(65536), nextOffset: integer.nullable() }).strict();
export type CausalHistoryChunk = z.infer<typeof chunkSchema>;

export async function causalHistoryHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertCausalHistoryChunk(accountId: string, position: CausalHistoryPosition, input: unknown): Promise<CausalHistoryChunk> {
  causalHistoryPosition.parse(position);
  const result = chunkSchema.safeParse(input);
  const fail = () => { throw new Error('The causal history chunk does not prove the requested position and bytes.'); };
  if (!result.success) return fail();
  const chunk = result.data;
  if (chunk.accountId !== accountId || chunk.epoch !== position.epoch || chunk.revision !== position.revision
    || chunk.throughRevision !== position.throughRevision || chunk.offset !== position.offset || chunk.offset >= chunk.totalBytes) return fail();
  let bytes: Uint8Array;
  try {
    const decoded = atob(chunk.data);
    if (btoa(decoded) !== chunk.data) return fail();
    bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  } catch (_) { return fail(); }
  const length = Math.min(CAUSAL_HISTORY_CHUNK_BYTES, chunk.totalBytes - chunk.offset);
  const next = chunk.offset + length < chunk.totalBytes ? chunk.offset + length : null;
  if (bytes.length !== length || chunk.nextOffset !== next || await causalHistoryHash(bytes) !== chunk.chunkSha256) return fail();
  return chunk;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** The cutover receipt is a separate contract from action acceptance. */
function assertCutoverReceipt(accountId: string, epoch: string, receipt: Record<string, any>) {
  const operation = receipt.operation; const record = receipt.record; const baseline = receipt.baseline;
  const fail = () => { throw new Error('Causal history did not prove its cutover baseline.'); };
  if (receipt.schemaVersion !== 2 || receipt.epoch !== epoch || receipt.projectionRevision !== 0
    || !object(operation) || operation.schemaVersion !== 2 || operation.accountId !== accountId || operation.cutoverId !== epoch
    || !object(record) || record.user_id !== accountId || record.entity_type !== 'tracking' || record.entity_id !== 'singleton'
    || !integer.min(1).safeParse(record.version).success || !integer.min(1).safeParse(record.server_version).success
    || typeof record.device_id !== 'string' || !record.device_id.length || record.deleted_at !== null
    || typeof record.updated_at !== 'string' || !Number.isFinite(Date.parse(record.updated_at)) || !object(record.payload)
    || operation.expectedTrackingServerVersion !== record.server_version || stableJson(operation.expectedTrackingPayload) !== stableJson(record.payload)) return fail();
  try { validateCounterBaseline(baseline); } catch (_) { return fail(); }
  if (baseline.accountId !== accountId || baseline.baselineId !== epoch || baseline.day !== record.payload.date
    || baseline.counts.planViewCount !== record.payload.planViewCount || baseline.counts.dailyPostponeCount !== record.payload.dailyPostponeCount
    || stableJson(baseline.evidenceIds) !== stableJson([epoch])) return fail();
}

/** Validate the complete reconstructed entry before durable history progress. */
export function assertCausalHistoryEntry(accountId: string, epoch: string, revision: number, input: unknown): Record<string, any> {
  if (!object(input) || input.schemaVersion !== 2 || input.accountId !== accountId || input.epoch !== epoch
    || input.revision !== revision || !integer.safeParse(revision).success || !object(input.receipt)) throw new Error('The causal history entry has a different identity.');
  if (revision === 0) assertCutoverReceipt(accountId, epoch, input.receipt);
  else if (input.receipt.operation?.type === 'completion') {
    const operation = parseCausalCompletion(accountId, input.receipt.operation);
    if (operation.epoch !== epoch || input.receipt.projectionRevision !== revision) throw new Error('The completion history has a different revision.');
    assertCausalCompletionReceipt(accountId, operation, input.receipt);
  } else {
    const operation = parseCausalOperation(accountId, input.receipt.operation);
    if (operation.epoch !== epoch || input.receipt.projectionRevision !== revision) throw new Error('The causal history receipt has a different revision.');
    assertCausalReceipt(accountId, operation, input.receipt);
  }
  return input;
}

export async function assembleCausalHistoryEntry(accountId: string, position: CausalHistoryPosition, chunks: readonly unknown[]) {
  causalHistoryPosition.parse(position);
  if (position.offset !== 0 || chunks.length < 1 || chunks.length > Math.ceil(MAX_CAUSAL_HISTORY_ENTRY_BYTES / CAUSAL_HISTORY_CHUNK_BYTES)) throw new Error('The causal history entry is incomplete.');
  let body: Uint8Array | undefined; let expectedHash = ''; let offset: number | null = 0;
  for (const raw of chunks) {
    if (offset === null) throw new Error('The causal history entry contains extra chunks.');
    const chunk = await assertCausalHistoryChunk(accountId, { ...position, offset }, raw);
    if (!body) { body = new Uint8Array(chunk.totalBytes); expectedHash = chunk.sha256; }
    if (body.length !== chunk.totalBytes || expectedHash !== chunk.sha256) throw new Error('The causal history manifest changed.');
    body.set(Uint8Array.from(atob(chunk.data), char => char.charCodeAt(0)), offset);
    offset = chunk.nextOffset;
  }
  if (!body || offset !== null || await causalHistoryHash(body) !== expectedHash) throw new Error('The complete causal history checksum is invalid or incomplete.');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch (_) { throw new Error('The causal history JSON is invalid.'); }
  return { body: new TextDecoder().decode(body), entry: assertCausalHistoryEntry(accountId, position.epoch, position.revision, decoded), sha256: expectedHash };
}
