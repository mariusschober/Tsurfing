import { describe, expect, it } from 'vitest';
import { assertNewSyncPayload, NEW_SYNC_PAYLOAD_BYTES, boundedPushBatch, transportablePushBatch, SYNC_REQUEST_BODY_BYTES, SYNC_STAGED_BODY_BYTES, SyncMutationTooLargeError, wireMutation } from './syncEnvelope';
import type { SyncMutation } from './syncProtocol';

const mutation = (text: string): SyncMutation => ({
  mutationId: '11111111-1111-4111-8111-111111111111', deviceId: 'fixture',
  entityType: 'tasks', entityId: 'fixture', version: 1, baseServerVersion: null,
  payload: { text }, updatedAt: '2026-09-07T00:00:00.123456789Z', deletedAt: null
});
const size = (items: SyncMutation[]) => new TextEncoder().encode(JSON.stringify({ mutations: items.map(wireMutation) })).byteLength;

describe('exact legacy request envelope', () => {
  it('admits the exact new-record byte boundary and counts JSON escaping', () => {
    const exact = 'x'.repeat(NEW_SYNC_PAYLOAD_BYTES - 2);
    expect(() => assertNewSyncPayload(exact)).not.toThrow();
    expect(() => assertNewSyncPayload(exact + 'x')).toThrow(/not saved/);
    expect(() => assertNewSyncPayload('\\'.repeat(NEW_SYNC_PAYLOAD_BYTES / 2))).toThrow(/3 MiB/);
  });
  it('stages one original mutation up to the exact 4 MiB boundary and preserves unsupported inputs', () => {
    const exact = mutation('x'.repeat(SYNC_STAGED_BODY_BYTES - size([mutation('')])));
    const snapshot = JSON.stringify(exact);
    expect(transportablePushBatch([exact, mutation('later')])).toEqual([exact]);
    expect(JSON.stringify(exact)).toBe(snapshot);
    const over = mutation((exact.payload as { text: string }).text + 'x');
    expect(() => transportablePushBatch([over])).toThrow(SyncMutationTooLargeError);
  });
  it('accepts the exact byte boundary, rejects one byte over, and leaves nanoseconds unchanged', () => {
    const exact = mutation('x'.repeat(SYNC_REQUEST_BODY_BYTES - size([mutation('')])));
    expect(size([exact])).toBe(SYNC_REQUEST_BODY_BYTES);
    expect(boundedPushBatch([exact])).toEqual([exact]);
    expect(wireMutation(exact).updatedAt).toBe('2026-09-07T00:00:00.123456789Z');
    expect(() => boundedPushBatch([mutation((exact.payload as { text: string }).text + 'x')])).toThrow(SyncMutationTooLargeError);
  });

  it('retains an ordered prefix and counts JSON escaping and multibyte characters', () => {
    const item = mutation('🧭"\\\n'.repeat(14_000));
    const queue = [item, { ...item, mutationId: '22222222-2222-4222-8222-222222222222' }];
    const snapshot = JSON.stringify(queue);
    expect(size(queue)).toBeGreaterThan(SYNC_REQUEST_BODY_BYTES);
    expect(boundedPushBatch(queue)).toEqual([item]);
    expect(JSON.stringify(queue)).toBe(snapshot);
  });

  it('also enforces the count limit and handles an empty queue', () => {
    expect(boundedPushBatch(Array.from({ length: 51 }, () => mutation('')))).toHaveLength(50);
    expect(boundedPushBatch([])).toEqual([]);
  });
});
