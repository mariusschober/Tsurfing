import type { SyncMutation } from './syncProtocol';

/** Express's 256kb limit counts the decoded HTTP body, excluding headers. */
export const SYNC_REQUEST_BODY_BYTES = 256 * 1024;
export const SYNC_BATCH_COUNT = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Keep the legacy request fields and canonicalization unchanged. Attempt/local
// metadata is deliberately not part of the HTTP request or its fingerprint.
export const wireMutation = (mutation: SyncMutation) => ({
  mutationId: mutation.mutationId,
  deviceId: mutation.deviceId,
  entityType: mutation.entityType,
  entityId: mutation.entityId,
  baseServerVersion: mutation.baseServerVersion,
  version: mutation.version,
  payload: mutation.payload,
  updatedAt: mutation.updatedAt,
  deletedAt: mutation.deletedAt,
  resolvesConflictId: mutation.resolvesConflictId && UUID_PATTERN.test(mutation.resolvesConflictId)
    ? mutation.resolvesConflictId : undefined
});

export class SyncMutationTooLargeError extends Error {
  constructor(readonly mutationId: string, readonly bodyBytes: number) {
    super('A preserved change exceeds the sync request limit. It remains saved locally; retry after large-record recovery is available.');
    this.name = 'SyncMutationTooLargeError';
  }
}

/** Select a prefix only: do not bypass dependencies or rewrite captured edits. */
export function boundedPushBatch(ready: SyncMutation[]): SyncMutation[] {
  let size = new TextEncoder().encode('{"mutations":[]}').byteLength;
  const batch: SyncMutation[] = [];
  for (const mutation of ready) {
    if (batch.length === SYNC_BATCH_COUNT) break;
    const itemBytes = new TextEncoder().encode(JSON.stringify(wireMutation(mutation))).byteLength;
    const nextSize = size + itemBytes + (batch.length ? 1 : 0);
    if (nextSize > SYNC_REQUEST_BODY_BYTES) {
      if (!batch.length) throw new SyncMutationTooLargeError(mutation.mutationId, nextSize);
      break;
    }
    batch.push(mutation);
    size = nextSize;
  }
  return batch;
}
