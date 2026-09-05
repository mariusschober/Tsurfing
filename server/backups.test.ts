import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from './config';
import {
  createEncryptedBackupForUser,
  decryptServerBackup,
  normalizeBackupForRestore,
  rotateEncryptedBackups,
  verifyRestoredBackupCollections
} from './backups';

const key = crypto.randomBytes(32);

const envelope = (payload: unknown): { encrypted: Buffer; checksum: string } => {
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const encrypted = Buffer.concat([Buffer.from('GFB1'), iv, cipher.getAuthTag(), ciphertext]);
  return { encrypted, checksum: crypto.createHash('sha256').update(plain).digest('hex') };
};

describe('server backup restore boundary', () => {
  it('decrypts only an authenticated backup with the expected owner payload', () => {
    const payload = {
      schemaVersion: 3,
      exportedAt: '2026-08-27T00:00:00Z',
      userId: '00000000-0000-4000-8000-000000000001',
      collections: { tasks: [], sync_mutations: [], sync_conflicts: [] }
    };
    const backup = envelope(payload);
    expect(decryptServerBackup(backup.encrypted, key.toString('hex'), backup.checksum)).toEqual(payload);
  });

  it('rejects modified ciphertext and checksum before returning collections', () => {
    const backup = envelope({
      schemaVersion: 3,
      exportedAt: '2026-08-27T00:00:00Z',
      userId: '00000000-0000-4000-8000-000000000001',
      collections: { tasks: [{ id: 'valuable' }] }
    });
    const modified = Buffer.from(backup.encrypted);
    modified[modified.length - 1] ^= 1;
    expect(() => decryptServerBackup(modified, key.toString('hex'), backup.checksum)).toThrow();
    expect(() => decryptServerBackup(backup.encrypted, key.toString('hex'), '0'.repeat(64))).toThrow('checksum');
  });

  it('rejects an invalid owner or export timestamp before restore data is exposed', () => {
    const invalidOwner = envelope({
      schemaVersion: 3,
      exportedAt: '2026-08-27T00:00:00Z',
      userId: 'not-an-account',
      collections: { tasks: [{ id: 'valuable' }] }
    });
    const invalidTimestamp = envelope({
      schemaVersion: 3,
      exportedAt: 'not-a-timestamp',
      userId: '00000000-0000-4000-8000-000000000001',
      collections: { tasks: [{ id: 'valuable' }] }
    });

    expect(() => decryptServerBackup(invalidOwner.encrypted, key.toString('hex'), invalidOwner.checksum))
      .toThrow('plaintext');
    expect(() => decryptServerBackup(invalidTimestamp.encrypted, key.toString('hex'), invalidTimestamp.checksum))
      .toThrow('plaintext');
  });

  it('marks metadata incomplete before upload and complete only after the object is durable', async () => {
    const events: string[] = [];
    let uploaded: Buffer | undefined;
    let inserted: Record<string, unknown> | undefined;
    const updateBuilder = {
      eq() { return this; },
      select() { return this; },
      async single() {
        events.push('metadata-complete');
        return { data: { object_path: inserted?.object_path }, error: null };
      }
    };
    const admin = {
      async rpc(name: string) {
        if (name === 'goalflow_backup_protocol_version') return { data: 2, error: null };
        if (name === 'export_goalflow_backup') return { data: { tasks: [{ id: 'valuable' }], ai_usage: [] }, error: null };
        return { data: null, error: new Error('unexpected RPC') };
      },
      from(table: string) {
        expect(table).toBe('backup_metadata');
        return {
          async insert(row: Record<string, unknown>) {
            inserted = row;
            events.push(`metadata-${row.status}`);
            return { error: null };
          },
          update() { return updateBuilder; }
        };
      },
      storage: {
        from(bucket: string) {
          expect(bucket).toBe('goalflow-backups');
          return {
            async upload(_path: string, bytes: Buffer) {
              events.push('object-upload');
              uploaded = bytes;
              return { error: null };
            },
            async download() {
              events.push('object-readback');
              return { data: new Blob([uploaded!]), error: null };
            }
          };
        }
      }
    } as unknown as SupabaseClient;
    const config = { BACKUP_MASTER_KEY: key.toString('hex') } as AppConfig;

    const created = await createEncryptedBackupForUser(
      config,
      admin,
      '00000000-0000-4000-8000-000000000001',
      { metadataKind: 'daily', pathKind: 'pre-restore' }
    );

    expect(events).toEqual(['metadata-failed', 'object-upload', 'object-readback', 'metadata-complete']);
    expect(inserted).toMatchObject({ status: 'failed', checksum: created.checksum, encryption_version: 2 });
    expect(created.encryptionVersion).toBe(2);
    expect(created.objectPath).toContain('/pre-restore/');
    expect(uploaded!.subarray(0, 4).toString('ascii')).toBe('GFB2');
    expect(decryptServerBackup(
      uploaded!, key.toString('hex'), created.checksum, '00000000-0000-4000-8000-000000000001'
    ).collections).toEqual({ tasks: [{ id: 'valuable' }], ai_usage: [] });
    expect(() => decryptServerBackup(
      uploaded!, key.toString('hex'), created.checksum, '00000000-0000-4000-8000-000000000002'
    )).toThrow('different user');
    const modifiedAuthenticatedUser = Buffer.from(uploaded!);
    modifiedAuthenticatedUser[39] = modifiedAuthenticatedUser[39] === 49 ? 50 : 49;
    expect(() => decryptServerBackup(modifiedAuthenticatedUser, key.toString('hex'), created.checksum)).toThrow();
  });

  it('leaves visible failed metadata when object upload fails', async () => {
    const statuses: unknown[] = [];
    const admin = {
      async rpc(name: string) {
        return name === 'goalflow_backup_protocol_version'
          ? { data: 2, error: null }
          : { data: { tasks: [] }, error: null };
      },
      from() {
        return {
          async insert(row: Record<string, unknown>) {
            statuses.push(row.status);
            return { error: null };
          }
        };
      },
      storage: { from: () => ({ upload: async () => ({ error: new Error('storage unavailable') }) }) }
    } as unknown as SupabaseClient;

    await expect(createEncryptedBackupForUser(
      { BACKUP_MASTER_KEY: key.toString('hex') } as AppConfig,
      admin,
      '00000000-0000-4000-8000-000000000001'
    )).rejects.toThrow('storage unavailable');
    expect(statuses).toEqual(['failed']);
  });

  it('does not finalize metadata when uploaded bytes cannot be verified', async () => {
    const statuses: unknown[] = [];
    let uploaded: Buffer | undefined;
    const admin = {
      async rpc(name: string) {
        return name === 'goalflow_backup_protocol_version'
          ? { data: 2, error: null }
          : { data: { tasks: [] }, error: null };
      },
      from() {
        return {
          async insert(row: Record<string, unknown>) {
            statuses.push(row.status);
            return { error: null };
          },
          update() {
            throw new Error('metadata must not be finalized');
          }
        };
      },
      storage: {
        from: () => ({
          async upload(_path: string, bytes: Buffer) {
            uploaded = bytes;
            return { error: null };
          },
          async download() {
            const corrupted = Buffer.from(uploaded!);
            corrupted[corrupted.length - 1] ^= 1;
            return { data: new Blob([corrupted]), error: null };
          }
        })
      }
    } as unknown as SupabaseClient;

    await expect(createEncryptedBackupForUser(
      { BACKUP_MASTER_KEY: key.toString('hex') } as AppConfig,
      admin,
      '00000000-0000-4000-8000-000000000001'
    )).rejects.toThrow('did not match');
    expect(statuses).toEqual(['failed']);
  });

  it('normalizes legacy usage state without changing the original backup', () => {
    const original = {
      schemaVersion: 3,
      exportedAt: '2026-08-27T00:00:00Z',
      userId: '00000000-0000-4000-8000-000000000001',
      collections: { tasks: [] }
    };

    const normalized = normalizeBackupForRestore(original);

    expect(normalized.collections).toEqual({
      tasks: [],
      telegram_captures: [],
      telegram_updates: [],
      sync_mutations: [],
      sync_conflicts: [],
      api_mutation_receipts: [],
      ai_usage: []
    });
    expect(original.collections).toEqual({ tasks: [] });
  });

  it('does not normalize an explicitly malformed historical collection', () => {
    const original = {
      schemaVersion: 3,
      exportedAt: '2026-08-27T00:00:00Z',
      userId: '00000000-0000-4000-8000-000000000001',
      collections: { tasks: [], ai_usage: null }
    };

    expect(normalizeBackupForRestore(original).collections.ai_usage).toBeNull();
  });

  it('marks a retention target failed when storage deletion is uncertain', async () => {
    const statusChanges: string[] = [];
    const listing = {
      eq() { return this; },
      async order() {
        return {
          data: [
            { id: 'kept', object_path: 'user/daily/kept.enc' },
            { id: 'expired', object_path: 'user/daily/expired.enc' }
          ],
          error: null
        };
      }
    };
    const admin = {
      from(table: string) {
        expect(table).toBe('backup_metadata');
        return {
          select() { return listing; },
          update(row: { status: string }) {
            statusChanges.push(row.status);
            return {
              eq() { return this; },
              select() { return this; },
              async single() { return { data: { id: 'expired' }, error: null }; }
            };
          }
        };
      },
      storage: {
        from(bucket: string) {
          expect(bucket).toBe('goalflow-backups');
          return { remove: async () => ({ data: null, error: new Error('storage uncertain') }) };
        }
      }
    } as unknown as SupabaseClient;

    await expect(rotateEncryptedBackups(admin, 'user', 'daily', 1)).rejects.toThrow('storage uncertain');
    expect(statusChanges).toEqual(['deleted', 'failed']);
  });

  it('verifies exact content identities while allowing append-only safety rows', () => {
    const row = (userId = '00000000-0000-4000-8000-000000000001') => ({ user_id: userId });
    const expected = {
      profiles: [row()],
      tasks: [{ id: 'task-a' }],
      daily_plans: [{ local_date: '2026-09-03' }],
      task_events: [{ id: 'event-a' }],
      telegram_identities: [{ telegram_user_id: 10 }],
      telegram_captures: [{ id: 'capture-a' }],
      telegram_updates: [{ update_id: 11 }],
      sync_records: [{ entity_type: 'tasks', entity_id: 'task-a' }],
      sync_mutations: [{ mutation_id: 'mutation-a' }],
      sync_conflicts: [{ id: 'conflict-a' }],
      api_mutation_receipts: [{ mutation_id: 'receipt-a' }],
      entitlements: [row()],
      ai_usage: [{ user_id: '00000000-0000-4000-8000-000000000001', usage_date: '2026-09-03', request_count: 3 }]
    };
    const actual = {
      ...expected,
      sync_records: [...expected.sync_records, { entity_type: 'tasks', entity_id: 'post-backup-tombstone' }],
      sync_conflicts: [...expected.sync_conflicts, { id: 'restore-conflict' }]
    };

    const verification = verifyRestoredBackupCollections(expected, actual);

    expect(verification.additionalSafetyRows.sync_records).toBe(1);
    expect(verification.additionalSafetyRows.sync_conflicts).toBe(1);
    expect(verification.additionalSafetyRows.tasks).toBe(0);
  });

  it('rejects a missing durable identity or extra replace-restored row', () => {
    const base = {
      profiles: [{ user_id: 'user-a' }], tasks: [{ id: 'task-a' }],
      daily_plans: [], task_events: [], telegram_identities: [], telegram_captures: [],
      telegram_updates: [], sync_records: [], sync_mutations: [], sync_conflicts: [],
      api_mutation_receipts: [], entitlements: [{ user_id: 'user-a' }], ai_usage: []
    };

    expect(() => verifyRestoredBackupCollections(base, {
      ...base,
      tasks: [{ id: 'different-task' }]
    })).toThrow('durable tasks identity');
    expect(() => verifyRestoredBackupCollections(base, {
      ...base,
      tasks: [...base.tasks, { id: 'unexpected-task' }]
    })).toThrow('unexpected tasks row count');
  });

  it('allows canonical projection rebasing while rejecting changed source content', () => {
    const base = {
      profiles: [{ user_id: 'user-a', timezone: 'UTC' }],
      tasks: [{ id: 'task-a', title: 'Keep me', revision: 4, sync_server_version: 10 }],
      daily_plans: [], task_events: [], telegram_identities: [], telegram_captures: [],
      telegram_updates: [],
      sync_records: [{
        entity_type: 'tasks', entity_id: 'task-a', version: 4, server_version: 10,
        device_id: 'before-restore', updated_at: '2026-09-03T00:00:00Z',
        payload: { title: 'Keep me' }, deleted_at: null
      }],
      sync_mutations: [], sync_conflicts: [], api_mutation_receipts: [],
      entitlements: [{ user_id: 'user-a', active: true }], ai_usage: []
    };
    const rebased = {
      ...base,
      tasks: [{ ...base.tasks[0], revision: 20, sync_server_version: 30 }],
      sync_records: [{
        ...base.sync_records[0], version: 20, server_version: 30,
        device_id: 'server-restore', updated_at: '2026-09-03T01:00:00Z',
        payload: { title: 'Canonical projection after rebase' },
        deleted_at: '2026-09-03T01:00:00Z'
      }]
    };
    expect(() => verifyRestoredBackupCollections(base, rebased)).not.toThrow();
    expect(() => verifyRestoredBackupCollections(base, {
      ...rebased,
      tasks: [{ ...rebased.tasks[0], title: 'Silently changed' }]
    })).toThrow('changed tasks content');
  });

  it('keeps non-canonical sync payloads byte-strict', () => {
    const base = {
      profiles: [{ user_id: 'user-a' }], tasks: [], daily_plans: [], task_events: [],
      telegram_identities: [], telegram_captures: [], telegram_updates: [],
      sync_records: [{
        entity_type: 'goals', entity_id: 'goal-a', version: 1, server_version: 10,
        device_id: 'before-restore', updated_at: '2026-09-03T00:00:00Z',
        payload: { title: 'Keep me' }, deleted_at: null
      }],
      sync_mutations: [], sync_conflicts: [], api_mutation_receipts: [],
      entitlements: [{ user_id: 'user-a' }], ai_usage: []
    };
    expect(() => verifyRestoredBackupCollections(base, {
      ...base,
      sync_records: [{
        ...base.sync_records[0], version: 20, server_version: 30,
        device_id: 'server-restore', updated_at: '2026-09-03T01:00:00Z',
        payload: { title: 'Silently changed' }
      }]
    })).toThrow('changed sync_records content');
  });

  it('allows quota growth but rejects quota rewind under the same date', () => {
    const base = {
      profiles: [{ user_id: 'user-a' }], tasks: [], daily_plans: [], task_events: [],
      telegram_identities: [], telegram_captures: [], telegram_updates: [], sync_records: [],
      sync_mutations: [], sync_conflicts: [], api_mutation_receipts: [],
      entitlements: [{ user_id: 'user-a' }],
      ai_usage: [{ user_id: 'user-a', usage_date: '2026-09-03', request_count: 5 }]
    };
    expect(() => verifyRestoredBackupCollections(base, {
      ...base,
      ai_usage: [{ ...base.ai_usage[0], request_count: 8 }]
    })).not.toThrow();
    expect(() => verifyRestoredBackupCollections(base, {
      ...base,
      ai_usage: [{ ...base.ai_usage[0], request_count: 4 }]
    })).toThrow('rewound');
  });
});
