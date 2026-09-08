import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  applySyncMutationsSequentially,
  assertDurableReceipt,
  canonicalSyncTimestamp,
  createSyncProtocolGuard,
  resolveCloudConflictRecord,
  syncMutationSchema
} from './sync';

const mutation = {
  mutationId: '11111111-1111-4111-8111-111111111111',
  deviceId: 'device-a',
  entityType: 'tasks' as const,
  entityId: 'task-1',
  baseServerVersion: null,
  version: 1,
  payload: { id: 'task-1', title: 'valuable' },
  updatedAt: '2026-08-27T00:00:00.000Z',
  deletedAt: null
};

const receipt = () => ({
  accepted: true,
  serverVersion: 7,
  record: {
    entity_type: mutation.entityType,
    entity_id: mutation.entityId,
    device_id: mutation.deviceId,
    version: mutation.version,
    server_version: 7,
    payload: mutation.payload,
    updated_at: mutation.updatedAt,
    deleted_at: mutation.deletedAt
  }
});

describe('sync API durable acceptance boundary', () => {
  it('verifies the immutable protocol once and retries a failed first check', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: new Error('temporarily unavailable') })
      .mockResolvedValue({ data: 3, error: null });
    const requireProtocol = createSyncProtocolGuard({ rpc } as unknown as SupabaseClient);

    await expect(requireProtocol()).rejects.toThrow(/protocol is not installed/i);
    await requireProtocol();
    await requireProtocol();
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes PostgREST UTC timestamps without losing fractional precision', () => {
    expect(canonicalSyncTimestamp('2026-09-05T00:25:06.813+00:00'))
      .toBe('2026-09-05T00:25:06.813Z');
    expect(canonicalSyncTimestamp('2026-09-05T00:25:06.813456+00:00'))
      .toBe('2026-09-05T00:25:06.813456Z');
    expect(canonicalSyncTimestamp('2026-09-05T00:25:06.42+00:00'))
      .toBe('2026-09-05T00:25:06.420Z');
    expect(canonicalSyncTimestamp('2026-09-05T00:25:06+00:00'))
      .toBe('2026-09-05T00:25:06.000Z');
    expect(() => canonicalSyncTimestamp('not-a-timestamp')).toThrow(/invalid timestamp/i);
  });

  it('admits native task-event records to the protocol-v3 transport', () => {
    expect(syncMutationSchema.parse({
      ...mutation,
      entityType: 'task_events',
      entityId: '22222222-2222-4222-8222-222222222222',
      payload: {
        id: '22222222-2222-4222-8222-222222222222',
        taskId: '33333333-3333-4333-8333-333333333333',
        eventType: 'completed',
        localDate: '2026-08-27',
        metadata: {},
        createdAt: 1_787_788_800_000
      }
    }).entityType).toBe('task_events');
  });

  it('accepts only a receipt proving the exact committed record', () => {
    expect(assertDurableReceipt(mutation, receipt())).toMatchObject({ accepted: true, serverVersion: 7 });
  });

  it.each([
    ['entity identity', { entity_id: 'task-2' }],
    ['device identity', { device_id: 'device-b' }],
    ['local version', { version: 2 }],
    ['server version', { server_version: 8 }],
    ['payload', { payload: { id: 'task-1', title: 'wrong' } }],
    ['update timestamp', { updated_at: '2026-08-27T00:00:01.000Z' }],
    ['tombstone timestamp', { deleted_at: '2026-08-27T00:00:01.000Z' }]
  ])('rejects an accepted RPC result with the wrong %s', (_label, recordPatch) => {
    const value = receipt();
    value.record = { ...value.record, ...recordPatch };
    expect(() => assertDurableReceipt(mutation, value)).toThrow(/exact durable server record/i);
  });

  it('rejects ambiguous acceptance flags even with a matching record', () => {
    expect(() => assertDurableReceipt(mutation, { ...receipt(), replayMismatch: true }))
      .toThrow(/exact durable server record/i);
  });

  it('processes a batch strictly in request order without overlapping RPC calls', async () => {
    let active = 0;
    let maximumActive = 0;
    const order: string[] = [];
    const rpc = vi.fn(async (_name: string, input: Record<string, unknown>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const entityId = String(input.target_entity_id);
      order.push(entityId);
      await Promise.resolve();
      active -= 1;
      return {
        error: null,
        data: {
          accepted: true,
          serverVersion: order.length,
          record: {
            entity_type: input.target_entity_type,
            entity_id: entityId,
            device_id: input.target_device_id,
            version: input.target_version,
            server_version: order.length,
            payload: input.target_payload,
            updated_at: input.target_updated_at,
            deleted_at: input.target_deleted_at
          }
        }
      };
    });
    const database = { rpc } as unknown as SupabaseClient;
    const mutations = ['first', 'second', 'third'].map((entityId, index) => syncMutationSchema.parse({
      ...mutation,
      mutationId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      entityType: 'settings',
      entityId,
      payload: { id: entityId }
    }));

    const results = await applySyncMutationsSequentially(database, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mutations);

    expect(order).toEqual(['first', 'second', 'third']);
    expect(maximumActive).toBe(1);
    expect(results.map(result => result.mutationId)).toEqual(mutations.map(item => item.mutationId));
  });

  it('stops at the first RPC failure so later dependent mutations are not attempted', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ error: new Error('database unavailable'), data: null });
    const database = { rpc } as unknown as SupabaseClient;
    const mutations = ['first', 'dependent'].map((entityId, index) => syncMutationSchema.parse({
      ...mutation,
      mutationId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      entityType: 'settings',
      entityId,
      payload: { id: entityId }
    }));

    await expect(applySyncMutationsSequentially(database, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mutations))
      .rejects.toThrow('database unavailable');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('acknowledges only the exact user-owned conflict row', async () => {
    const conflictId = '22222222-2222-4222-8222-222222222222';
    const mutationId = '33333333-3333-4333-8333-333333333333';
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      error: null,
      data: { id: conflictId, mutation_id: mutationId, resolved_at: '2026-09-03T00:00:00.000Z' }
    }));
    const database = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    await expect(resolveCloudConflictRecord(
      database,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      conflictId,
      mutationId
    )).resolves.toEqual({ resolved: true, conflictId, mutationId });
    expect(chain.eq.mock.calls).toEqual([
      ['user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['id', conflictId],
      ['mutation_id', mutationId]
    ]);
  });

  it('does not acknowledge a conflict update that matched no row', async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.select = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ error: null, data: null }));
    const database = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    await expect(resolveCloudConflictRecord(
      database,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    )).resolves.toBeNull();
  });
});
