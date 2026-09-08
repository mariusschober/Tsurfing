import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from './config';

const decodeKey = (value: string): Buffer => {
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_MASTER_KEY must decode to exactly 32 bytes.');
  return key;
};

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_MAGIC = Buffer.from('GFB1');
const DERIVED_KEY_MAGIC = Buffer.from('GFB2');
const DERIVED_KEY_USER_BYTES = 36;
const DERIVED_KEY_SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ENCRYPTED_BACKUP_BYTES = 50 * 1024 * 1024;

export const serverBackupEnvelopeVersion = (encrypted: Buffer): 1 | 2 => {
  const magic = encrypted.subarray(0, 4);
  if (magic.equals(LEGACY_MAGIC)) return 1;
  if (magic.equals(DERIVED_KEY_MAGIC)) return 2;
  throw new Error('Backup envelope is invalid.');
};

const normalizeUserId = (userId: string): string => {
  if (!USER_ID_PATTERN.test(userId)) throw new Error('Backup user identity is invalid.');
  return userId.toLowerCase();
};

const deriveUserKey = (masterKey: Buffer, userId: string, salt: Buffer): Buffer => Buffer.from(
  crypto.hkdfSync(
    'sha256',
    masterKey,
    salt,
    Buffer.from(`goalflow-server-backup:v2:${normalizeUserId(userId)}`, 'utf8'),
    32
  )
);

const encrypt = (payload: Buffer, masterKey: Buffer, userId: string): Buffer => {
  const normalizedUserId = normalizeUserId(userId);
  const userBytes = Buffer.from(normalizedUserId, 'ascii');
  const salt = crypto.randomBytes(DERIVED_KEY_SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const prefix = Buffer.concat([DERIVED_KEY_MAGIC, userBytes, salt, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveUserKey(masterKey, normalizedUserId, salt), iv);
  cipher.setAAD(prefix);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([prefix, tag, ciphertext]);
};

export interface DecryptedServerBackup {
  schemaVersion: number;
  exportedAt: string;
  userId: string;
  collections: Record<string, unknown>;
}

/** Verifies the encrypted envelope and plaintext checksum before any restore RPC can run. */
export const decryptServerBackup = (
  encrypted: Buffer,
  masterKey: string,
  expectedChecksum?: string,
  expectedUserId?: string
): DecryptedServerBackup => {
  if (encrypted.length > MAX_ENCRYPTED_BACKUP_BYTES || encrypted.length < 48) {
    throw new Error('Backup envelope is invalid.');
  }
  const master = decodeKey(masterKey);
  const magic = encrypted.subarray(0, 4);
  let envelopeUserId: string | undefined;
  let key: Buffer;
  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  let aad: Buffer | undefined;

  if (magic.equals(DERIVED_KEY_MAGIC)) {
    const prefixLength = DERIVED_KEY_MAGIC.length + DERIVED_KEY_USER_BYTES + DERIVED_KEY_SALT_BYTES + IV_BYTES;
    if (encrypted.length <= prefixLength + TAG_BYTES) throw new Error('Backup envelope is invalid.');
    envelopeUserId = normalizeUserId(
      encrypted.subarray(DERIVED_KEY_MAGIC.length, DERIVED_KEY_MAGIC.length + DERIVED_KEY_USER_BYTES).toString('ascii')
    );
    if (expectedUserId && normalizeUserId(expectedUserId) !== envelopeUserId) {
      throw new Error('Backup envelope belongs to a different user.');
    }
    const saltStart = DERIVED_KEY_MAGIC.length + DERIVED_KEY_USER_BYTES;
    const salt = encrypted.subarray(saltStart, saltStart + DERIVED_KEY_SALT_BYTES);
    const ivStart = saltStart + DERIVED_KEY_SALT_BYTES;
    iv = encrypted.subarray(ivStart, ivStart + IV_BYTES);
    tag = encrypted.subarray(prefixLength, prefixLength + TAG_BYTES);
    ciphertext = encrypted.subarray(prefixLength + TAG_BYTES);
    aad = encrypted.subarray(0, prefixLength);
    key = deriveUserKey(master, envelopeUserId, salt);
  } else if (magic.equals(LEGACY_MAGIC)) {
    iv = encrypted.subarray(4, 16);
    tag = encrypted.subarray(16, 32);
    ciphertext = encrypted.subarray(32);
    key = master;
  } else {
    throw new Error('Backup envelope is invalid.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const checksum = crypto.createHash('sha256').update(plain).digest('hex');
  if (expectedChecksum) {
    if (!/^[a-f0-9]{64}$/i.test(expectedChecksum)
      || !crypto.timingSafeEqual(Buffer.from(checksum), Buffer.from(expectedChecksum.toLowerCase()))) {
      throw new Error('Backup checksum validation failed.');
    }
  }
  const parsed = JSON.parse(plain.toString('utf8')) as Partial<DecryptedServerBackup>;
  if (!Number.isInteger(parsed.schemaVersion) || Number(parsed.schemaVersion) < 1 || Number(parsed.schemaVersion) > 4) {
    throw new Error('Backup schema version is unsupported.');
  }
  if (typeof parsed.exportedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(parsed.exportedAt)
    || !Number.isFinite(Date.parse(parsed.exportedAt))
    || typeof parsed.userId !== 'string'
    || !USER_ID_PATTERN.test(parsed.userId)
    || !parsed.collections
    || typeof parsed.collections !== 'object' || Array.isArray(parsed.collections)) {
    throw new Error('Backup plaintext is invalid.');
  }
  const payloadUserId = normalizeUserId(parsed.userId);
  if ((envelopeUserId && envelopeUserId !== payloadUserId)
    || (expectedUserId && normalizeUserId(expectedUserId) !== payloadUserId)) {
    throw new Error('Backup owner does not match its authenticated envelope or restore target.');
  }
  return parsed as DecryptedServerBackup;
};

const COLLECTION_IDENTITIES = {
  profiles: ['user_id'],
  tasks: ['id'],
  daily_plans: ['local_date'],
  task_events: ['id'],
  telegram_identities: ['telegram_user_id'],
  telegram_captures: ['id'],
  telegram_updates: ['update_id'],
  sync_records: ['entity_type', 'entity_id'],
  sync_mutations: ['mutation_id'],
  sync_conflicts: ['id'],
  api_mutation_receipts: ['mutation_id'],
  entitlements: ['user_id'],
  ai_usage: ['usage_date']
} as const;

const EXACT_RESTORE_COLLECTIONS = new Set<string>([
  'profiles', 'tasks', 'daily_plans', 'task_events', 'telegram_identities',
  'telegram_captures', 'telegram_updates', 'entitlements'
]);

const RESTORE_MUTABLE_FIELDS: Partial<Record<keyof typeof COLLECTION_IDENTITIES, ReadonlySet<string>>> = {
  tasks: new Set(['revision', 'sync_server_version']),
  daily_plans: new Set(['revision', 'sync_server_version']),
  sync_records: new Set(['version', 'server_version', 'device_id', 'updated_at']),
  sync_conflicts: new Set(['server_version', 'server_payload', 'server_deleted_at']),
  ai_usage: new Set(['request_count'])
};

export interface BackupRestoreVerification {
  expectedCounts: Record<string, number>;
  actualCounts: Record<string, number>;
  additionalSafetyRows: Record<string, number>;
}

/** Adds only fields absent from historical backup schemas; original rows are never rewritten. */
export const normalizeBackupForRestore = (backup: DecryptedServerBackup): DecryptedServerBackup => {
  const collections = { ...backup.collections };
  for (const collection of [
    'telegram_captures', 'telegram_updates', 'sync_mutations',
    'sync_conflicts', 'api_mutation_receipts', 'ai_usage'
  ]) {
    if (!Object.prototype.hasOwnProperty.call(collections, collection)) collections[collection] = [];
  }
  return { ...backup, collections };
};

const collectionIdentitySet = (
  collections: Record<string, unknown>,
  collection: keyof typeof COLLECTION_IDENTITIES
): { count: number; identities: Set<string>; rowsByIdentity: Map<string, Record<string, unknown>> } => {
  const rows = collections[collection];
  if (!Array.isArray(rows)) throw new Error(`Backup collection ${collection} is missing or invalid.`);
  const fields = COLLECTION_IDENTITIES[collection];
  const identities = new Set<string>();
  const rowsByIdentity = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`Backup collection ${collection} contains an invalid row.`);
    }
    const record = row as Record<string, unknown>;
    const values = fields.map(field => record[field]);
    if (values.some(value => (typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0)) {
      throw new Error(`Backup collection ${collection} contains a row without a durable identity.`);
    }
    const identity = JSON.stringify(values);
    if (identities.has(identity)) throw new Error(`Backup collection ${collection} contains duplicate durable identities.`);
    identities.add(identity);
    rowsByIdentity.set(identity, record);
  }
  return { count: rows.length, identities, rowsByIdentity };
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
};

const comparableRestoreRow = (
  collection: keyof typeof COLLECTION_IDENTITIES,
  row: Record<string, unknown>,
  canonicalProjection = false
): Record<string, unknown> => {
  const mutable = RESTORE_MUTABLE_FIELDS[collection];
  if (!mutable && !canonicalProjection) return row;
  return Object.fromEntries(Object.entries(row).filter(([field]) => {
    if (mutable?.has(field)) return false;
    // The restore RPC intentionally reprojects canonical tasks and daily plans
    // after rebasing their revisions. Their exact source rows are verified in
    // the replace-restored collections above, so comparing the stale transport
    // payload or tombstone timestamp would turn a safe rebase into a false
    // failure. Non-canonical sync payloads remain byte-strict.
    return !canonicalProjection || (field !== 'payload' && field !== 'deleted_at');
  }));
};

const canonicalProjectionIdentities = (collections: Record<string, unknown>): Set<string> => {
  const identities = new Set<string>();
  const tasks = collections.tasks;
  if (Array.isArray(tasks)) {
    for (const value of tasks) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const task = value as Record<string, unknown>;
      const entityId = typeof task.legacy_entity_id === 'string' && task.legacy_entity_id.length > 0
        ? task.legacy_entity_id
        : task.id;
      if (typeof entityId === 'string' && entityId.length > 0) {
        identities.add(JSON.stringify(['tasks', entityId]));
      }
    }
  }
  const plans = collections.daily_plans;
  if (Array.isArray(plans)) {
    for (const value of plans) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const localDate = (value as Record<string, unknown>).local_date;
      if (typeof localDate === 'string' && localDate.length > 0) {
        identities.add(JSON.stringify(['daily_plans', localDate]));
      }
    }
  }
  return identities;
};

/**
 * Verifies exact durable IDs/counts for replace-restored data. Append-only
 * receipts, conflicts, quota usage, and restore tombstones may contain newer
 * safety rows, but every row present in the backup must still exist.
 */
export const verifyRestoredBackupCollections = (
  expectedCollections: Record<string, unknown>,
  actualCollections: Record<string, unknown>
): BackupRestoreVerification => {
  const expectedCounts: Record<string, number> = {};
  const actualCounts: Record<string, number> = {};
  const additionalSafetyRows: Record<string, number> = {};
  const projectedIdentities = canonicalProjectionIdentities(expectedCollections);
  for (const collection of Object.keys(COLLECTION_IDENTITIES) as (keyof typeof COLLECTION_IDENTITIES)[]) {
    const expected = collectionIdentitySet(expectedCollections, collection);
    const actual = collectionIdentitySet(actualCollections, collection);
    expectedCounts[collection] = expected.count;
    actualCounts[collection] = actual.count;
    for (const identity of expected.identities) {
      if (!actual.identities.has(identity)) {
        throw new Error(`Restore verification could not find a durable ${collection} identity.`);
      }
      const expectedRow = expected.rowsByIdentity.get(identity)!;
      const actualRow = actual.rowsByIdentity.get(identity)!;
      const canonicalProjection = collection === 'sync_records' && projectedIdentities.has(identity);
      if (canonicalJson(comparableRestoreRow(collection, expectedRow, canonicalProjection))
        !== canonicalJson(comparableRestoreRow(collection, actualRow, canonicalProjection))) {
        throw new Error(`Restore verification found changed ${collection} content for a durable identity.`);
      }
      if (collection === 'ai_usage') {
        const expectedCount = Number(expectedRow.request_count);
        const actualCount = Number(actualRow.request_count);
        if (!Number.isSafeInteger(expectedCount) || expectedCount < 0
          || !Number.isSafeInteger(actualCount) || actualCount < expectedCount) {
          throw new Error('Restore verification found rewound or invalid AI quota usage.');
        }
      }
    }
    if (EXACT_RESTORE_COLLECTIONS.has(collection) && actual.count !== expected.count) {
      throw new Error(`Restore verification found an unexpected ${collection} row count.`);
    }
    if (!EXACT_RESTORE_COLLECTIONS.has(collection) && actual.count < expected.count) {
      throw new Error(`Restore verification found fewer ${collection} rows than the backup contained.`);
    }
    additionalSafetyRows[collection] = actual.count - expected.count;
  }
  return { expectedCounts, actualCounts, additionalSafetyRows };
};

export const rotateEncryptedBackups = async (
  admin: SupabaseClient,
  userId: string,
  kind: 'daily' | 'weekly',
  keep: number
): Promise<void> => {
  const { data, error } = await admin.from('backup_metadata').select('id,object_path')
    .eq('user_id', userId).eq('backup_kind', kind).eq('status', 'complete')
    .order('created_at', { ascending: false });
  if (error) throw error;
  const expired = (data ?? []).slice(keep);
  for (const item of expired) {
    // Delete one object at a time. A partial batch response must not make an
    // uncertain object look like a completed, restorable backup.
    const { data: marked, error: metadataError } = await admin.from('backup_metadata')
      .update({ status: 'deleted' })
      .eq('id', item.id).eq('user_id', userId).eq('status', 'complete')
      .select('id').single();
    if (metadataError || !marked) {
      throw metadataError ?? new Error('Backup retention could not durably mark its target.');
    }
    const { error: removeError } = await admin.storage.from('goalflow-backups').remove([item.object_path]);
    if (removeError) {
      const { data: failed, error: recoveryError } = await admin.from('backup_metadata')
        .update({ status: 'failed' })
        .eq('id', item.id).eq('user_id', userId).eq('status', 'deleted')
        .select('id').single();
      if (recoveryError || !failed) {
        throw new AggregateError(
          [removeError, recoveryError ?? new Error('Backup retention state could not be recovered.')],
          'Backup rotation failed and its metadata state is uncertain.'
        );
      }
      throw removeError;
    }
  }
};

export interface CreatedEncryptedBackup {
  userId: string;
  objectPath: string;
  checksum: string;
  byteSize: number;
  exportedAt: string;
  encryptionVersion: 2;
}

const requireBackupProtocol = async (admin: SupabaseClient): Promise<void> => {
  const { data: protocolVersion, error: protocolError } = await admin.rpc('goalflow_backup_protocol_version');
  if (protocolError || Number(protocolVersion) !== 2) {
    throw new Error('Backups were not started because the complete data-integrity schema is not installed.');
  }
};

/**
 * Creates one encrypted, checksummed user backup. Metadata is inserted in a
 * visible failed state before the object upload; a crash can therefore leave
 * an incomplete backup, but never an undiscoverable object presented as valid.
 */
export const createEncryptedBackupForUser = async (
  config: AppConfig,
  admin: SupabaseClient,
  userId: string,
  options: {
    metadataKind?: 'daily' | 'weekly' | 'pre-restore';
    pathKind?: 'daily' | 'weekly' | 'pre-restore';
    protocolAlreadyVerified?: boolean;
  } = {}
): Promise<CreatedEncryptedBackup> => {
  if (!config.BACKUP_MASTER_KEY) throw new Error('Encrypted backups are not configured.');
  if (!options.protocolAlreadyVerified) await requireBackupProtocol(admin);
  const key = decodeKey(config.BACKUP_MASTER_KEY);
  const { data: collections, error: exportError } = await admin.rpc('export_goalflow_backup', {
    target_user_id: userId
  });
  if (exportError) throw exportError;
  if (!collections || typeof collections !== 'object' || Array.isArray(collections)) {
    throw new Error('Database backup export returned an invalid snapshot.');
  }
  const exportedAt = new Date().toISOString();
  const plain = Buffer.from(JSON.stringify({ schemaVersion: 4, exportedAt, userId, collections }), 'utf8');
  const checksum = crypto.createHash('sha256').update(plain).digest('hex');
  const encrypted = encrypt(plain, key, userId);
  const metadataKind = options.metadataKind ?? (new Date().getUTCDay() === 0 ? 'weekly' : 'daily');
  const pathKind = options.pathKind ?? metadataKind;
  const objectPath = `${userId}/${pathKind}/${exportedAt.replace(/[:.]/g, '-')}.goalflow-backup.enc`;

  const { error: metadataError } = await admin.from('backup_metadata').insert({
    user_id: userId,
    object_path: objectPath,
    backup_kind: metadataKind,
    checksum,
    byte_size: encrypted.length,
    encryption_version: 2,
    status: 'failed'
  });
  if (metadataError) throw metadataError;

  const { error: uploadError } = await admin.storage.from('goalflow-backups').upload(objectPath, encrypted, {
    contentType: 'application/octet-stream', upsert: false, cacheControl: '0'
  });
  if (uploadError) throw uploadError;

  // An upload response alone is not proof that the exact encrypted object can
  // be read durably. Read it back and verify both the ciphertext bytes and the
  // authenticated plaintext before exposing complete metadata.
  const { data: uploadedObject, error: downloadError } = await admin.storage
    .from('goalflow-backups').download(objectPath);
  if (downloadError || !uploadedObject) {
    throw downloadError ?? new Error('Uploaded backup could not be read back for verification.');
  }
  const verifiedEncrypted = Buffer.from(await uploadedObject.arrayBuffer());
  if (verifiedEncrypted.length !== encrypted.length
    || !crypto.timingSafeEqual(verifiedEncrypted, encrypted)) {
    throw new Error('Uploaded backup bytes did not match the encrypted backup.');
  }
  decryptServerBackup(verifiedEncrypted, config.BACKUP_MASTER_KEY, checksum, userId);

  const { data: completedMetadata, error: completeError } = await admin.from('backup_metadata')
    .update({ status: 'complete' })
    .eq('user_id', userId).eq('object_path', objectPath).eq('status', 'failed')
    .select('object_path').single();
  if (completeError || !completedMetadata) {
    throw completeError ?? new Error('Backup upload completed but durable metadata was not finalized.');
  }
  return { userId, objectPath, checksum, byteSize: encrypted.length, exportedAt, encryptionVersion: 2 };
};

export const runEncryptedBackups = async (config: AppConfig, admin: SupabaseClient): Promise<number> => {
  if (!config.BACKUP_MASTER_KEY) throw new Error('Encrypted backups are not configured.');
  await requireBackupProtocol(admin);
  const { data: profiles, error: profileError } = await admin.from('profiles').select('user_id').eq('status', 'active');
  if (profileError) throw profileError;
  let completed = 0;

  for (const profile of profiles ?? []) {
    const kind: 'daily' | 'weekly' = new Date().getUTCDay() === 0 ? 'weekly' : 'daily';
    await createEncryptedBackupForUser(config, admin, String(profile.user_id), {
      metadataKind: kind,
      pathKind: kind,
      protocolAlreadyVerified: true
    });
    await rotateEncryptedBackups(admin, profile.user_id, 'daily', 7);
    await rotateEncryptedBackups(admin, profile.user_id, 'weekly', 4);
    completed += 1;
  }
  return completed;
};
