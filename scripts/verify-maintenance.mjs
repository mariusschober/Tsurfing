import { spawnSync } from 'node:child_process';

const childEnvironment = { ...process.env };
for (const name of [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OWNER_USER_ID',
  'BACKUP_MASTER_KEY',
  'RAILWAY_GIT_COMMIT_SHA'
]) delete childEnvironment[name];

const runProbe = (releaseSha) => spawnSync(process.execPath, ['dist/server/maintenance.mjs'], {
  env: {
    ...childEnvironment,
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://goalflow.invalid',
    ENABLE_LOCAL_DEMO: 'false',
    TELEGRAM_ENABLED: 'false',
    AI_ENABLED: 'false',
    VOICE_ENABLED: 'false',
    TURNSTILE_ENABLED: 'false',
    BACKUPS_ENABLED: 'true',
    ...(releaseSha ? { RAILWAY_GIT_COMMIT_SHA: releaseSha } : {})
  },
  encoding: 'utf8'
});

const readFailure = (result) => {
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error('Maintenance reported success without its required cloud dependencies.');
  }

  let event;
  try {
    event = JSON.parse(result.stderr.trim());
  } catch {
    throw new Error('Maintenance failure was not emitted as a safe structured event.');
  }
  if (event?.event !== 'maintenance.failed' || event?.category !== 'MaintenanceConfigurationError') {
    throw new Error('Maintenance did not expose the expected fail-closed category.');
  }
  if (JSON.stringify(event).includes('undefined') || JSON.stringify(event).includes('BACKUP_MASTER_KEY=')) {
    throw new Error('Maintenance disclosed sensitive configuration material.');
  }
  return event;
};

if (readFailure(runProbe()).releaseSha !== null) {
  throw new Error('Maintenance reported an unverified deployment revision.');
}
const expectedReleaseSha = 'a'.repeat(40);
if (readFailure(runProbe(expectedReleaseSha)).releaseSha !== expectedReleaseSha) {
  throw new Error('Maintenance did not preserve exact deployment revision provenance.');
}

console.log(JSON.stringify({ status: 'ok', contract: 'maintenance-fails-closed' }));
