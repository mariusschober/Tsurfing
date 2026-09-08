import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  appendStagedTransactions,
  applyPushResults,
  applyRemotePage,
  buildStagedLocalTransaction,
  emptySyncMeta,
  mergeServerConflicts,
  normalizeSyncMeta,
  readyOutbox,
  resolveConflictWithLocal,
  syncEntityKey,
  type StagedLocalTransaction,
  type SyncMeta,
  type SyncMutation
} from './syncProtocol';

const iso = (index: number) => new Date(index * 1_000).toISOString();

const transaction = (
  index: number,
  entityId: string,
  payload: Record<string, unknown>,
  deletedAt: string | null = null
): StagedLocalTransaction => ({
  id: `tx-${index}`,
  userKey: 'user',
  storeName: 'tasks',
  storageKey: 'user',
  value: [payload],
  changes: [{
    mutationId: `mutation-${index}`,
    entityType: 'tasks',
    entityId,
    payload,
    updatedAt: iso(index),
    deletedAt
  }],
  order: index,
  createdAt: iso(index)
});

const representedMutationIds = (meta: SyncMeta): string[] => [
  ...meta.outbox.map(item => item.mutationId),
  ...meta.conflicts.flatMap(conflict => conflict.localHistory.map(item => item.mutationId))
];

const acceptedReceipt = (mutation: SyncMutation, serverVersion: number) => ({
  mutationId: mutation.mutationId,
  accepted: true,
  serverVersion,
  record: {
    entityType: mutation.entityType,
    entityId: mutation.entityId,
    deviceId: mutation.deviceId,
    version: mutation.version,
    serverVersion,
    payload: mutation.payload,
    updatedAt: mutation.updatedAt,
    deletedAt: mutation.deletedAt
  }
});

describe('record-level synchronization invariants', () => {
  it('never normalizes a damaged pending mutation into an empty outbox', () => {
    expect(() => normalizeSyncMeta('damaged')).toThrow(/not discarded/i);
    expect(() => normalizeSyncMeta({ outbox: [null], conflicts: [] })).toThrow(/not discarded/i);
    expect(() => normalizeSyncMeta({
      outbox: [],
      conflicts: [{ entityType: 'tasks', localHistory: [null] }]
    })).toThrow(/history entry/i);
  });

  it('migrates a legacy task snapshot into retry-stable record mutations without inventing deletes', () => {
    const legacy = {
      cursor: 4,
      versions: { tasks: { local: 3, server: 2 } },
      outbox: [{
        mutationId: '5a09cfb8-d178-49ee-8aab-ed8e04c51527',
        deviceId: 'old-device',
        entityType: 'tasks',
        entityId: 'singleton',
        baseServerVersion: 2,
        version: 3,
        payload: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
        updatedAt: iso(3),
        deletedAt: null
      }],
      conflicts: []
    };
    const first = normalizeSyncMeta(legacy);
    const second = normalizeSyncMeta(legacy);
    expect(first.outbox.map(item => item.entityId)).toEqual(['a', 'b']);
    expect(first.outbox.map(item => item.mutationId)).toEqual(second.outbox.map(item => item.mutationId));
    expect(first.outbox.every(item => item.deletedAt === null && item.baseServerVersion === null)).toBe(true);
  });

  it('rejects a mutation-id collision while allowing an exact WAL replay', () => {
    const first = buildStagedLocalTransaction(
      'tasks', 'user', [], [{ id: 'a', title: 'first' }], 1, iso(1), () => 'same-id'
    )!;
    const once = appendStagedTransactions(emptySyncMeta(), [first], 'device-a');
    expect(appendStagedTransactions(once, [first], 'device-a').outbox).toHaveLength(1);
    const collision = buildStagedLocalTransaction(
      'tasks', 'user', [{ id: 'a', title: 'first' }], [{ id: 'a', title: 'different' }], 2, iso(2), () => 'same-id'
    )!;
    expect(() => appendStagedTransactions(once, [collision], 'device-a')).toThrow(/collision/i);
  });

  it('creates independent mutations when two tasks change', () => {
    let uuid = 0;
    const staged = buildStagedLocalTransaction(
      'tasks',
      'user',
      [{ id: 'a', title: 'A0' }, { id: 'b', title: 'B0' }],
      [{ id: 'a', title: 'A1' }, { id: 'b', title: 'B1' }],
      1,
      iso(1),
      () => `uuid-${++uuid}`
    );
    expect(staged?.changes.map(change => change.entityId)).toEqual(['a', 'b']);
    const meta = appendStagedTransactions(emptySyncMeta(), [staged!], 'device-a');
    expect(readyOutbox(meta).map(item => item.entityId).sort()).toEqual(['a', 'b']);
  });

  it('synchronizes planning decisions per local date instead of overwriting the whole plan store', () => {
    let uuid = 0;
    const previous = [
      { id: '2099-01-01', localDate: '2099-01-01', taskIds: ['a'], confirmedAt: 1 },
      { id: '2099-01-02', localDate: '2099-01-02', taskIds: ['b'], confirmedAt: 1 }
    ];
    const next = [
      { id: '2099-01-01', localDate: '2099-01-01', taskIds: ['a', 'c'], confirmedAt: 2 },
      previous[1]
    ];
    const staged = buildStagedLocalTransaction(
      'daily_plans', 'user', previous, next, 1, iso(1), () => `plan-uuid-${++uuid}`
    )!;

    expect(staged.changes).toHaveLength(1);
    expect(staged.changes[0]).toMatchObject({
      entityType: 'daily_plans',
      entityId: '2099-01-01',
      deletedAt: null
    });

    const remoteOtherDay = applyRemotePage(
      appendStagedTransactions(emptySyncMeta(), [staged], 'device-a'),
      { daily_plans: next },
      [{
        entityType: 'daily_plans', entityId: '2099-01-03', version: 1, serverVersion: 8,
        deviceId: 'device-b',
        payload: { id: '2099-01-03', localDate: '2099-01-03', taskIds: ['d'], confirmedAt: 3 },
        deletedAt: null
      }],
      8,
      'device-a',
      iso(2)
    );
    expect(remoteOtherDay.meta.conflicts).toHaveLength(0);
    expect(remoteOtherDay.meta.outbox).toHaveLength(1);
    expect(remoteOtherDay.values.daily_plans).toEqual([
      ...next,
      { id: '2099-01-03', localDate: '2099-01-03', taskIds: ['d'], confirmedAt: 3 }
    ]);
  });

  it('chains create then complete and advances the base only after acceptance', () => {
    const create = transaction(1, 'task', { id: 'task', title: 'Promise', completed: false });
    const complete = transaction(2, 'task', { id: 'task', title: 'Promise', completed: true });
    let meta = appendStagedTransactions(emptySyncMeta(), [create, complete], 'device-a');

    expect(readyOutbox(meta).map(item => item.mutationId)).toEqual(['mutation-1']);
    const createBatch = readyOutbox(meta);
    meta = applyPushResults(meta, createBatch, [acceptedReceipt(createBatch[0], 11)], iso(3));

    const next = readyOutbox(meta);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ mutationId: 'mutation-2', baseServerVersion: 11 });
  });

  it('moves a rejected mutation and every dependent edit into one durable conflict', () => {
    const edits = [
      transaction(1, 'same', { id: 'same', title: 'one' }),
      transaction(2, 'same', { id: 'same', title: 'two' }),
      transaction(3, 'same', { id: 'same', title: 'three' })
    ];
    let meta = appendStagedTransactions(emptySyncMeta(), edits, 'device-a');
    const batch = readyOutbox(meta);
    meta = applyPushResults(meta, batch, [{
      mutationId: batch[0].mutationId,
      accepted: false,
      serverVersion: 9,
      conflictId: 'conflict-1',
      record: { payload: { id: 'same', title: 'remote' } }
    }], iso(4));

    expect(meta.outbox).toHaveLength(0);
    expect(meta.conflicts).toHaveLength(1);
    expect(meta.conflicts[0].localHistory.map(item => item.mutationId))
      .toEqual(['mutation-1', 'mutation-2', 'mutation-3']);
    expect(meta.conflicts[0].localPayload).toEqual({ id: 'same', title: 'three' });
    expect(meta.conflicts[0].serverPayload).toEqual({ id: 'same', title: 'remote' });
  });

  it('hydrates a server-only restore conflict with both recoverable versions', () => {
    const meta = mergeServerConflicts(emptySyncMeta(), [{
      id: '99999999-9999-4999-8999-999999999999',
      entity_type: 'tasks',
      entity_id: 'valuable-task',
      mutation_id: '88888888-8888-4888-8888-888888888888',
      local_payload: { id: 'valuable-task', title: 'newer pre-restore version' },
      local_deleted_at: null,
      local_version: 7,
      local_updated_at: iso(7),
      server_payload: { id: 'valuable-task', title: 'restored version' },
      server_deleted_at: null,
      server_missing: false,
      server_version: 12,
      created_at: iso(12)
    }]);

    expect(meta.conflicts).toHaveLength(1);
    expect(meta.conflicts[0].localHistory).toEqual([expect.objectContaining({
      mutationId: '88888888-8888-4888-8888-888888888888',
      payload: { id: 'valuable-task', title: 'newer pre-restore version' },
      version: 7
    })]);
    expect(meta.conflicts[0].serverPayload).toEqual({ id: 'valuable-task', title: 'restored version' });
  });

  it('never replaces a newer preserved conflict side with an older ledger response', () => {
    const serverConflict = {
      id: '99999999-9999-4999-8999-999999999999',
      entity_type: 'tasks',
      entity_id: 'valuable-task',
      mutation_id: '88888888-8888-4888-8888-888888888888',
      local_payload: { id: 'valuable-task', title: 'local' },
      local_version: 7,
      local_updated_at: iso(7),
      server_payload: { id: 'valuable-task', title: 'server v12' },
      server_version: 12,
      server_missing: false,
      created_at: iso(12)
    };
    const newest = mergeServerConflicts(
      mergeServerConflicts(emptySyncMeta(), [serverConflict]),
      [{ ...serverConflict, server_payload: { id: 'valuable-task', title: 'server v13' }, server_version: 13 }]
    );
    const afterStaleReplay = mergeServerConflicts(newest, [serverConflict]);

    expect(afterStaleReplay.conflicts[0]).toMatchObject({
      serverPayload: { id: 'valuable-task', title: 'server v13' },
      serverVersion: 13
    });
    expect(() => mergeServerConflicts(afterStaleReplay, [{
      ...serverConflict,
      server_payload: { id: 'valuable-task', title: 'different v13' },
      server_version: 13
    }])).toThrow(/different cloud data/i);
    expect(() => mergeServerConflicts(afterStaleReplay, [{
      ...serverConflict,
      local_payload: { id: 'valuable-task', title: 'different local data' },
      server_payload: { id: 'valuable-task', title: 'server v13' },
      server_version: 13
    }])).toThrow(/different local data/i);
    expect(() => mergeServerConflicts(afterStaleReplay, [{
      ...serverConflict,
      local_version: 8,
      server_payload: { id: 'valuable-task', title: 'server v13' },
      server_version: 13
    }])).toThrow(/different local data/i);
    expect(() => mergeServerConflicts(afterStaleReplay, [{
      ...serverConflict,
      local_updated_at: iso(8),
      server_payload: { id: 'valuable-task', title: 'server v13' },
      server_version: 13
    }])).toThrow(/different local data/i);
    expect(() => mergeServerConflicts(afterStaleReplay, [{
      ...serverConflict,
      local_deleted_at: iso(8),
      server_payload: { id: 'valuable-task', title: 'server v13' },
      server_version: 13
    }])).toThrow(/different local data/i);
  });

  it('does not consume an outbox entry for a malformed acknowledgement', () => {
    const meta = appendStagedTransactions(
      emptySyncMeta(), [transaction(1, 'same', { id: 'same', title: 'local' })], 'device-a'
    );
    const batch = readyOutbox(meta);
    expect(() => applyPushResults(meta, batch, [{
      mutationId: batch[0].mutationId,
      accepted: true,
      serverVersion: 0
    }], iso(2))).toThrow(/invalid/i);
    expect(meta.outbox).toHaveLength(1);
  });

  it.each([
    ['entity identity', { entityId: 'different-task' }],
    ['device identity', { deviceId: 'device-b' }],
    ['local version', { version: 99 }],
    ['server version', { serverVersion: 99 }],
    ['payload', { payload: { id: 'same', title: 'different' } }],
    ['update timestamp', { updatedAt: iso(99) }],
    ['tombstone timestamp', { deletedAt: iso(99) }]
  ])('keeps a mutation pending when an accepted receipt has the wrong %s', (_label, recordPatch) => {
    const meta = appendStagedTransactions(
      emptySyncMeta(), [transaction(1, 'same', { id: 'same', title: 'local' })], 'device-a'
    );
    const batch = readyOutbox(meta);
    const receipt = acceptedReceipt(batch[0], 8);
    receipt.record = { ...receipt.record, ...recordPatch };

    expect(() => applyPushResults(meta, batch, [receipt], iso(2))).toThrow(/exact submitted record/i);
    expect(meta.outbox).toHaveLength(1);
    expect(meta.conflicts).toHaveLength(0);
  });

  it('does not consume mutations when a server conflict id collides', () => {
    const initial = appendStagedTransactions(
      emptySyncMeta(),
      [
        transaction(1, 'one', { id: 'one', title: 'one' }),
        transaction(2, 'two', { id: 'two', title: 'two' })
      ],
      'device-a'
    );
    const batch = readyOutbox(initial);
    expect(() => applyPushResults(initial, batch, batch.map((mutation, index) => ({
      mutationId: mutation.mutationId,
      accepted: false,
      serverVersion: index + 1,
      conflictId: 'same-conflict-id',
      record: { payload: { id: mutation.entityId, title: 'server' } }
    })), iso(3))).toThrow(/conflict id/i);
    expect(initial.outbox).toHaveLength(2);
    expect(initial.conflicts).toHaveLength(0);
  });

  it('chains edits made while an explicit local conflict resolution is pending', () => {
    let meta = appendStagedTransactions(
      emptySyncMeta(),
      [transaction(1, 'same', { id: 'same', title: 'local one' })],
      'device-a'
    );
    meta = applyPushResults(meta, readyOutbox(meta), [{
      mutationId: 'mutation-1', accepted: false, serverVersion: 4,
      conflictId: 'conflict-1', record: { payload: { id: 'same', title: 'cloud' } }
    }], iso(2));
    meta = resolveConflictWithLocal(meta, 'conflict-1', 'device-a', iso(3), 'resolution-1');
    meta = appendStagedTransactions(
      meta,
      [transaction(4, 'same', { id: 'same', title: 'local two' })],
      'device-a'
    );

    expect(readyOutbox(meta).map(item => item.mutationId)).toEqual(['resolution-1']);
    expect(meta.outbox.find(item => item.mutationId === 'mutation-4')?.dependsOnMutationId)
      .toBe('resolution-1');
    const resolutionBatch = readyOutbox(meta);
    meta = applyPushResults(meta, resolutionBatch, [acceptedReceipt(resolutionBatch[0], 5)], iso(5));
    expect(meta.conflicts).toHaveLength(0);
    expect(readyOutbox(meta)[0]).toMatchObject({ mutationId: 'mutation-4', baseServerVersion: 5 });
  });

  it('preserves the original history when a local conflict resolution is rejected', () => {
    let meta = appendStagedTransactions(
      emptySyncMeta(),
      [transaction(1, 'same', { id: 'same', title: 'local one' })],
      'device-a'
    );
    meta = applyPushResults(meta, readyOutbox(meta), [{
      mutationId: 'mutation-1', accepted: false, serverVersion: 4,
      conflictId: 'conflict-1', record: { payload: { id: 'same', title: 'cloud one' } }
    }], iso(2));
    meta = resolveConflictWithLocal(meta, 'conflict-1', 'device-a', iso(3), 'resolution-1');
    meta = appendStagedTransactions(
      meta,
      [transaction(4, 'same', { id: 'same', title: 'local two' })],
      'device-a'
    );

    meta = applyPushResults(meta, readyOutbox(meta), [{
      mutationId: 'resolution-1', accepted: false, serverVersion: 6,
      conflictId: 'conflict-2', record: { payload: { id: 'same', title: 'cloud two' } }
    }], iso(6));

    expect(meta.outbox).toHaveLength(0);
    expect(meta.conflicts).toHaveLength(1);
    expect(meta.conflicts[0]).toMatchObject({
      id: 'conflict-2',
      localPayload: { id: 'same', title: 'local two' },
      serverPayload: { id: 'same', title: 'cloud two' },
      status: 'unresolved'
    });
    expect(meta.conflicts[0].localHistory.map(item => item.mutationId))
      .toEqual(['mutation-1', 'resolution-1', 'mutation-4']);
  });

  it('applies a different-task remote edit without conflicting or replacing local work', () => {
    const meta = appendStagedTransactions(
      emptySyncMeta(),
      [transaction(1, 'local', { id: 'local', title: 'offline' })],
      'device-a'
    );
    const applied = applyRemotePage(
      meta,
      { tasks: [{ id: 'local', title: 'offline' }, { id: 'remote', title: 'old' }] },
      [{
        entityType: 'tasks', entityId: 'remote', version: 1, serverVersion: 7,
        deviceId: 'device-b', payload: { id: 'remote', title: 'new' }, deletedAt: null
      }],
      7,
      'device-a',
      iso(2)
    );

    expect(applied.meta.conflicts).toHaveLength(0);
    expect(applied.meta.outbox.map(item => item.entityId)).toEqual(['local']);
    expect(applied.values.tasks).toEqual([
      { id: 'local', title: 'offline' },
      { id: 'remote', title: 'new' }
    ]);
  });

  it('durably represents native task events before sharing their cursor', () => {
    const event = {
      id: 'event-1', taskId: 'task-1', eventType: 'completed',
      localDate: '2026-08-27', metadata: { source: 'native' }, createdAt: 1_777_776_000_000
    };
    const applied = applyRemotePage(
      emptySyncMeta(),
      { task_events: [] },
      [{
        entityType: 'task_events', entityId: event.id, version: 1, serverVersion: 9,
        deviceId: 'native-device', payload: event, deletedAt: null
      }],
      9,
      'web-device',
      iso(2)
    );

    expect(applied.meta.cursor).toBe(9);
    expect(applied.values.task_events).toEqual([event]);
    expect(applied.changedStores).toContain('task_events');
  });

  it('preserves both sides of a same-task pull conflict before advancing the cursor', () => {
    const meta = appendStagedTransactions(
      emptySyncMeta(),
      [transaction(1, 'same', { id: 'same', title: 'local' })],
      'device-a'
    );
    const applied = applyRemotePage(
      meta,
      { tasks: [{ id: 'same', title: 'local' }] },
      [{
        entityType: 'tasks', entityId: 'same', version: 2, serverVersion: 12,
        deviceId: 'device-b', payload: { id: 'same', title: 'remote' }, deletedAt: null
      }],
      12,
      'device-a',
      iso(2)
    );

    expect(applied.meta.cursor).toBe(12);
    expect(applied.meta.outbox).toHaveLength(0);
    expect(applied.meta.conflicts[0]).toMatchObject({
      entityId: 'same',
      localPayload: { id: 'same', title: 'local' },
      serverPayload: { id: 'same', title: 'remote' }
    });
  });

  it('retains the newest remote side while a same-task conflict remains open', () => {
    const staged = appendStagedTransactions(
      emptySyncMeta(), [transaction(1, 'same', { id: 'same', title: 'local' })], 'device-a'
    );
    const first = applyRemotePage(
      staged,
      { tasks: [{ id: 'same', title: 'local' }] },
      [{
        entityType: 'tasks', entityId: 'same', version: 2, serverVersion: 12,
        deviceId: 'device-b', payload: { id: 'same', title: 'remote one' }, deletedAt: null
      }],
      12,
      'device-a',
      iso(2)
    );
    const newest = applyRemotePage(
      first.meta,
      first.values,
      [{
        entityType: 'tasks', entityId: 'same', version: 3, serverVersion: 13,
        deviceId: 'device-c', payload: { id: 'same', title: 'remote two' }, deletedAt: null
      }],
      13,
      'device-a',
      iso(3)
    );

    expect(newest.meta.cursor).toBe(13);
    expect(newest.meta.conflicts).toHaveLength(1);
    expect(newest.meta.conflicts[0]).toMatchObject({
      localPayload: { id: 'same', title: 'local' },
      serverPayload: { id: 'same', title: 'remote two' },
      serverVersion: 13
    });
    expect(newest.values.tasks).toEqual([{ id: 'same', title: 'local' }]);
  });

  it('rejects stale or duplicate pull records before advancing the cursor', () => {
    const current = { ...emptySyncMeta(), cursor: 10 };
    expect(() => applyRemotePage(
      current,
      { tasks: [] },
      [{
        entityType: 'tasks', entityId: 'one', version: 1, serverVersion: 10,
        deviceId: 'device-b', payload: { id: 'one', title: 'stale' }, deletedAt: null
      }],
      10,
      'device-a',
      iso(1)
    )).toThrow(/stale/i);
    expect(() => applyRemotePage(
      current,
      { tasks: [] },
      [
        {
          entityType: 'tasks', entityId: 'one', version: 1, serverVersion: 11,
          deviceId: 'device-b', payload: { id: 'one', title: 'one' }, deletedAt: null
        },
        {
          entityType: 'tasks', entityId: 'two', version: 1, serverVersion: 11,
          deviceId: 'device-b', payload: { id: 'two', title: 'two' }, deletedAt: null
        }
      ],
      11,
      'device-a',
      iso(1)
    )).toThrow(/duplicate/i);
  });

  it('refuses to advance a cursor beyond the remote records actually represented', () => {
    expect(() => applyRemotePage(
      emptySyncMeta(),
      { tasks: [] },
      [{
        entityType: 'tasks', entityId: 'one', version: 1, serverVersion: 5,
        deviceId: 'device-b', payload: { id: 'one', title: 'one' }, deletedAt: null
      }],
      6,
      'device-a',
      iso(1)
    )).toThrow(/skip or discard/i);
  });

  it('merges legacy snapshots and never treats omission as deletion', () => {
    const applied = applyRemotePage(
      emptySyncMeta(),
      { tasks: [{ id: 'keep', title: 'keep' }] },
      [{
        entityType: 'tasks', entityId: 'singleton', version: 1, serverVersion: 5,
        deviceId: 'old-device', payload: [{ id: 'other', title: 'other' }], deletedAt: null
      }],
      5,
      'new-device',
      iso(1)
    );
    expect(applied.values.tasks).toEqual([
      { id: 'keep', title: 'keep' },
      { id: 'other', title: 'other' }
    ]);
  });

  it('does not resurrect a deleted record from a stale edit', () => {
    const deleted = applyRemotePage(
      emptySyncMeta(),
      { tasks: [{ id: 'task', title: 'old' }] },
      [{
        entityType: 'tasks', entityId: 'task', version: 2, serverVersion: 20,
        deviceId: 'device-b', payload: { id: 'task', title: 'old' }, deletedAt: iso(20)
      }],
      20,
      'device-a',
      iso(20)
    );
    expect(deleted.values.tasks).toEqual([]);

    const staleLocal = appendStagedTransactions(
      deleted.meta,
      [transaction(21, 'task', { id: 'task', title: 'stale edit' })],
      'device-a'
    );
    expect(readyOutbox(staleLocal)[0].baseServerVersion).toBe(20);
    const conflict = applyPushResults(staleLocal, readyOutbox(staleLocal), [{
      mutationId: 'mutation-21', accepted: false, serverVersion: 22,
      record: { payload: { id: 'task', title: 'old' }, deletedAt: iso(20) }
    }], iso(22));
    expect(conflict.conflicts[0].localPayload).toEqual({ id: 'task', title: 'stale edit' });
    expect(conflict.conflicts[0].serverDeletedAt).toBe(iso(20));
  });

  it('carries a retained local task tombstone in the mutation envelope', () => {
    const deletedAt = iso(30);
    const staged = buildStagedLocalTransaction(
      'tasks',
      'user',
      [{ id: 'task', title: 'valuable', lifecycleStatus: 'open' }],
      [{ id: 'task', title: 'valuable', lifecycleStatus: 'archived', deletedAt }],
      30,
      deletedAt,
      () => crypto.randomUUID()
    )!;

    expect(staged.changes).toHaveLength(1);
    expect(staged.changes[0]).toMatchObject({ entityId: 'task', deletedAt });
  });

  it('never loses a randomized mutation across accept, retry, and conflict transitions', () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        entity: fc.integer({ min: 0, max: 4 }),
        accepted: fc.boolean()
      }), { minLength: 1, maxLength: 80 }),
      operations => {
        let meta = emptySyncMeta();
        const acceptedIds = new Set<string>();
        operations.forEach((operation, index) => {
          meta = appendStagedTransactions(meta, [transaction(
            index + 1,
            `task-${operation.entity}`,
            { id: `task-${operation.entity}`, title: `edit-${index + 1}` }
          )], 'device-a');
        });

        let decision = 0;
        while (readyOutbox(meta).length) {
          const batch = readyOutbox(meta, 50);
          const results = batch.map(mutation => {
            const accepted = operations[decision++ % operations.length].accepted;
            if (accepted) acceptedIds.add(mutation.mutationId);
            return {
              mutationId: mutation.mutationId,
              accepted,
              serverVersion: 100 + decision,
              conflictId: accepted ? undefined : `conflict-${mutation.mutationId}`,
              record: accepted ? acceptedReceipt(mutation, 100 + decision).record
                : { payload: { id: mutation.entityId, title: 'server' } }
            };
          });
          meta = applyPushResults(meta, batch, results, iso(100 + decision));
        }

        const represented = [...acceptedIds, ...representedMutationIds(meta)];
        const expected = operations.map((_, index) => `mutation-${index + 1}`);
        expect(represented.sort()).toEqual(expected.sort());
        expect(new Set(represented).size).toBe(represented.length);
        for (const [key, version] of Object.entries(meta.versions)) {
          expect(key).toBe(syncEntityKey('tasks', key.split(':').slice(1).join(':')));
          expect(version.local).toBeGreaterThan(0);
        }
      }
    ), { numRuns: 250 });
  });
});
