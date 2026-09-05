import { readConfig } from '../server/config';
import { createAdminClient } from '../server/supabase';
import {
  createEncryptedBackupForUser,
  decryptServerBackup,
  normalizeBackupForRestore,
  serverBackupEnvelopeVersion,
  verifyRestoredBackupCollections,
  type CreatedEncryptedBackup
} from '../server/backups';

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hasFlag = (name: string): boolean => process.argv.includes(name);
const userId = argument('--user');
const objectPath = argument('--object');
const confirmedUser = argument('--confirm-user');
const expectedRevision = argument('--expect-revision')?.toLowerCase();
const dryRun = hasFlag('--dry-run');
const execute = hasFlag('--execute');
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

let preRestoreBackup: CreatedEncryptedBackup | undefined;

const usage = 'Usage: npm run restore:backup -- --user <uuid> --object <path> --dry-run '
  + '[--expect-revision <40-character sha>]\n'
  + '   or: npm run restore:backup -- --user <uuid> --object <path> --execute '
  + '--confirm-user <same uuid> --expect-revision <40-character sha>';

const main = async (): Promise<void> => {
  if (!userId || !USER_ID_PATTERN.test(userId) || !objectPath || dryRun === execute
    || objectPath.includes('..') || !objectPath.startsWith(`${userId}/`)
    || (execute && (confirmedUser !== userId || !expectedRevision)) || (dryRun && confirmedUser)
    || (expectedRevision !== undefined && !RELEASE_SHA_PATTERN.test(expectedRevision))) {
    throw new Error(usage);
  }

  const config = readConfig({ ...process.env, NODE_ENV: 'production' });
  const releaseSha = config.RAILWAY_GIT_COMMIT_SHA?.toLowerCase() ?? null;
  if (expectedRevision && releaseSha !== expectedRevision) {
    throw new Error('Restore deployment revision does not match --expect-revision.');
  }
  if (!config.BACKUP_MASTER_KEY) throw new Error('BACKUP_MASTER_KEY is not configured.');
  const admin = createAdminClient(config);
  if (!admin) throw new Error('Supabase server access is not configured.');

  const { data: metadata, error: metadataError } = await admin.from('backup_metadata')
    .select('object_path,checksum,status,byte_size,encryption_version')
    .eq('user_id', userId)
    .eq('object_path', objectPath)
    .eq('status', 'complete')
    .single();
  if (metadataError || !metadata) throw metadataError ?? new Error('Completed backup metadata was not found.');

  const { data: object, error: downloadError } = await admin.storage.from('goalflow-backups').download(objectPath);
  if (downloadError || !object) throw downloadError ?? new Error('Encrypted backup object was not found.');
  const encrypted = Buffer.from(await object.arrayBuffer());
  const expectedBytes = Number(metadata.byte_size);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== encrypted.length) {
    throw new Error('Encrypted backup size does not match durable metadata.');
  }
  const envelopeVersion = serverBackupEnvelopeVersion(encrypted);
  if (Number(metadata.encryption_version) !== envelopeVersion) {
    throw new Error('Encrypted backup version does not match durable metadata.');
  }
  const backup = normalizeBackupForRestore(decryptServerBackup(
    encrypted,
    config.BACKUP_MASTER_KEY,
    String(metadata.checksum),
    userId
  ));

  const { data: validation, error: validationError } = await admin.rpc('validate_goalflow_backup_v2', {
    target_user_id: userId,
    backup_payload: backup
  });
  if (validationError || !validation || validation.valid !== true) {
    throw validationError ?? new Error('Database dry-run validation did not confirm the backup.');
  }

  if (dryRun) {
    process.stdout.write(`${JSON.stringify({
      mode: 'dry-run',
      valid: true,
      releaseSha,
      userId,
      objectPath,
      schemaVersion: backup.schemaVersion,
      encryptionVersion: envelopeVersion,
      validation
    })}\n`);
    return;
  }

  // A successful but operator-mistaken point-in-time restore still needs a
  // recovery path. Abort before touching the database unless current state has
  // itself been encrypted, uploaded, and marked complete.
  preRestoreBackup = await createEncryptedBackupForUser(config, admin, userId, {
    metadataKind: 'pre-restore',
    pathKind: 'pre-restore'
  });

  const { data: result, error: restoreError } = await admin.rpc('restore_goalflow_backup_v2', {
    target_user_id: userId,
    backup_payload: backup
  });
  if (restoreError || !result || result.restored !== true) {
    throw restoreError ?? new Error('Transactional restore did not report durable completion.');
  }

  // A successful RPC is necessary but not sufficient. Re-export the committed
  // state and prove every backed-up durable identity remains present. Exact
  // content tables must also retain exact row counts; append-only recovery
  // ledgers may contain newer safety records.
  const { data: restoredCollections, error: verificationExportError } = await admin.rpc('export_goalflow_backup', {
    target_user_id: userId
  });
  if (verificationExportError || !restoredCollections || typeof restoredCollections !== 'object'
    || Array.isArray(restoredCollections)) {
    throw verificationExportError ?? new Error('Restored state could not be re-exported for verification.');
  }
  const verification = verifyRestoredBackupCollections(backup.collections, restoredCollections);

  process.stdout.write(`${JSON.stringify({
    mode: 'execute',
    restored: true,
    releaseSha,
    userId,
    objectPath,
    result,
    verification,
    preRestoreBackup
  })}\n`);
};

try {
  await main();
} catch (error) {
  console.error(JSON.stringify({
    level: 'error',
    event: 'backup.restore_failed',
    message: error instanceof Error ? error.message : 'Backup restore failed.',
    ...(preRestoreBackup ? { recoveryObjectPath: preRestoreBackup.objectPath } : {})
  }));
  process.exitCode = 1;
}
