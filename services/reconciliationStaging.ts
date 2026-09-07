import { stableJson, type ReconciliationCandidate } from './syncProtocol';

export const RECONCILIATION_CHUNK_BYTES = 65536;
export const MAX_RECONCILIATION_BYTES = 4 * 1024 * 1024;
export interface ReconciliationManifest { schemaVersion: 1; sha256: string; totalBytes: number; chunkCount: number; chunkHashes: string[] }
export interface ReconciliationChunk { manifest: ReconciliationManifest; chunkIndex: number; chunkSha256: string; data: string }

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(pieces.join(''));
}

/** Capture bytes before the first await. Hash/chunk the complete candidate,
 * including every original history identity, timestamp and payload. */
export async function prepareReconciliation(candidate: ReconciliationCandidate): Promise<{
  body: string; manifest: ReconciliationManifest | null; chunks: ReconciliationChunk[];
}> {
  const body = JSON.stringify(candidate);
  if (candidate.localHistory.length > 100000) {
    throw new Error('Saved reconciliation exceeds 100,000 entries. The complete history remains preserved.');
  }
  return prepareStagedBody(body, candidate.localHistory.length > 1000);
}

/** Stage captured wire bytes without changing any logical mutation identity. */
export async function prepareStagedBody(body: string, force = false): Promise<{
  body: string; manifest: ReconciliationManifest | null; chunks: ReconciliationChunk[];
}> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.length <= 262144 && !force) return { body, manifest: null, chunks: [] };
  if (bytes.length > MAX_RECONCILIATION_BYTES) {
    throw new Error('Saved reconciliation exceeds the supported 4 MiB or 100,000-entry envelope. The complete history remains preserved and needs larger-record recovery.');
  }
  const chunkHashes: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += RECONCILIATION_CHUNK_BYTES) {
    chunkHashes.push(await sha256(bytes.subarray(offset, offset + RECONCILIATION_CHUNK_BYTES)));
  }
  const manifest: ReconciliationManifest = { schemaVersion: 1, sha256: await sha256(bytes),
    totalBytes: bytes.length, chunkCount: chunkHashes.length, chunkHashes };
  const chunks: ReconciliationChunk[] = [];
  for (let offset = 0; offset < bytes.length; offset += RECONCILIATION_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + RECONCILIATION_CHUNK_BYTES);
    chunks.push({ manifest, chunkIndex: chunks.length, chunkSha256: chunkHashes[chunks.length], data: base64(chunk) });
  }
  return { body, manifest, chunks };
}

export function verifyReconciliationChunkAck(chunk: ReconciliationChunk, value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('Reconciliation staging did not acknowledge the chunk.');
  const ack = value as Record<string, unknown>;
  if (ack.staged !== true || ack.chunkIndex !== chunk.chunkIndex || ack.chunkSha256 !== chunk.chunkSha256
    || stableJson(ack.manifest) !== stableJson(chunk.manifest)) {
    throw new Error('Reconciliation staging did not acknowledge the exact chunk. The history remains saved.');
  }
}
