import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const directory = path.resolve('supabase/migrations');
const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
assert(files.length > 0, 'No Supabase migrations found.');
const migrations = files.map(file => ({ file, sql: fs.readFileSync(path.join(directory, file), 'utf8') }));
const latest = migrations.find(item => item.file === '202608260001_zero_silent_data_loss.sql');
const nativeEvents = migrations.find(item => item.file === '202608290001_native_task_events.sql');
const transportCompletion = migrations.find(item => item.file === '202608300001_complete_native_sync_transport.sql');
const telegramAuth = migrations.find(item => item.file === '202608310001_telegram_auth_state_pkce.sql');
const accessBoundary = migrations.find(item => item.file === '202609030001_access_boundary_hardening.sql');
const accountLifecycle = migrations.find(item => item.file === '202609030002_account_lifecycle.sql');
const backupHardening = migrations.find(item => item.file === '202609030003_backup_restore_hardening.sql');
const telegramCaptureConfirmation = migrations.find(item => item.file === '202609030007_telegram_capture_confirmation.sql');
const emailOtpActivation = migrations.find(item => item.file === '202609040001_email_otp_activation.sql');
const realtimeSyncWakeup = migrations.find(item => item.file === '202609040003_realtime_sync_wakeup.sql');
const databaseAdvisorHardening = migrations.find(item => item.file === '202609040004_database_advisor_hardening.sql');
assert(latest, 'Data-integrity migration is missing.');
assert(nativeEvents, 'Native task-event projection migration is missing.');
assert(transportCompletion, 'Native synchronization transport completion migration is missing.');
assert(telegramAuth, 'Telegram auth state PKCE migration is missing.');
assert(accessBoundary, 'Access-boundary hardening migration is missing.');
assert(accountLifecycle, 'Account lifecycle migration is missing.');
assert(backupHardening, 'Backup/restore hardening migration is missing.');
assert(telegramCaptureConfirmation, 'Atomic Telegram capture confirmation migration is missing.');
assert(emailOtpActivation, 'Typed email OTP activation migration is missing.');
assert(realtimeSyncWakeup, 'Transactional Realtime sync wake-up migration is missing.');
assert(databaseAdvisorHardening, 'Database advisor hardening migration is missing.');

for (const migration of migrations) {
  const quoteCount = migration.sql.split('$$').length - 1;
  assert.equal(quoteCount % 2, 0, `${migration.file} has unbalanced dollar quotes.`);
}

// Empty-database path: every table altered by the new migration must have been
// created by an earlier migration, in lexical migration order.
const beforeLatest = migrations.filter(item => item.file < latest.file).map(item => item.sql).join('\n').toLowerCase();
for (const table of ['sync_mutations', 'tasks', 'sync_conflicts', 'sync_records', 'daily_plans']) {
  assert(
    beforeLatest.includes(`create table if not exists public.${table}`),
    `Empty-database migration path does not create ${table} before it is changed.`
  );
}

// Current-schema path: schema changes are additive/idempotent. Function bodies
// are stripped before checking top-level destructive DDL/DML; DELETE is allowed
// only inside the explicitly invoked transactional restore function.
const withoutBodies = latest.sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BODY$$').toLowerCase();
for (const forbidden of [
  /\bdrop\s+table\b/,
  /\btruncate\b/,
  /\bdrop\s+column\b/,
  /\balter\s+column\s+[^;]+\s+type\b/,
  /\bdelete\s+from\b/
]) {
  assert(!forbidden.test(withoutBodies), `Top-level destructive migration statement matched ${forbidden}.`);
}
const addColumnClauses = latest.sql.match(/add\s+column(?:\s+if\s+not\s+exists)?/gi) ?? [];
assert(addColumnClauses.length >= 5, 'Expected additive data-integrity columns are missing.');
assert(addColumnClauses.every(clause => /if\s+not\s+exists/i.test(clause)), 'Every added production column must be idempotent.');

for (const required of [
  'create or replace function public.push_sync_mutation_v2',
  'create or replace function public.goalflow_sync_protocol_version',
  'create or replace function public.export_goalflow_backup',
  'create or replace function public.restore_goalflow_backup',
  'create or replace function public.project_goalflow_daily_plan_sync',
  'create or replace function public.mirror_goalflow_daily_plan_to_sync',
  'create or replace function public.goalflow_create_task_idempotent',
  'create or replace function public.goalflow_confirm_plan_idempotent',
  'create table if not exists public.api_mutation_receipts'
]) {
  assert(latest.sql.toLowerCase().includes(required), `Required migration object is missing: ${required}`);
}

assert(
  latest.sql.includes('select 3;') && latest.sql.includes('target_resolves_conflict_id uuid'),
  'Protocol v3 and transactional conflict resolution are not both present.'
);
assert(
  latest.sql.includes('pre_restore_sync_records')
    && latest.sql.includes("'server-restore'")
    && latest.sql.includes('goalflow_next_change_version()')
    && latest.sql.includes('previous.payload is distinct from current_record.payload'),
  'Restore does not visibly rebase restored records and tombstones beyond old cursors.'
);
assert(
  !/delete\s+from\s+public\.(sync_mutations|api_mutation_receipts)/i.test(
    latest.sql.match(/create or replace function public\.restore_goalflow_backup[\s\S]*?\$\$;/i)?.[0] ?? ''
  ),
  'Restore must not erase append-only idempotency evidence.'
);

const receiptTypePosition = latest.sql.indexOf('create table if not exists public.api_mutation_receipts');
const restorePosition = latest.sql.indexOf('create or replace function public.restore_goalflow_backup');
assert(receiptTypePosition >= 0 && receiptTypePosition < restorePosition, 'Restore function is created before its receipt row type.');

assert(
  nativeEvents.sql.includes('project_goalflow_task_event_sync')
    && nativeEvents.sql.includes("new.entity_type <> 'task_events'")
    && nativeEvents.sql.includes('Task event identity is already used for different history'),
  'Native task-event projection is not append-only and identity-safe.'
);
assert(
  transportCompletion.sql.includes("'daily_plans'',''task_events''")
    && transportCompletion.sql.includes('Protocol-v3 synchronization RPC has an unexpected validation body')
    && transportCompletion.sql.includes("jsonb_typeof(record.payload) = 'object'")
    && transportCompletion.sql.includes("'trueNorthGoalId', task_row.true_north_goal_id")
    && transportCompletion.sql.includes('mirror_goalflow_task_event_to_sync')
    && transportCompletion.sql.includes('pg_trigger_depth() > 1'),
  'Native event transport or lossless canonical payload preservation is incomplete.'
);
assert(
  accessBoundary.sql.includes('revoke execute on all functions in schema public')
    && accessBoundary.sql.includes('revoke all privileges on table')
    && accessBoundary.sql.includes('tasks_parent_same_owner_fk')
    && accessBoundary.sql.includes('task_events_task_same_owner_fk')
    && accessBoundary.sql.includes('validate_goalflow_daily_plan_ownership')
    && accessBoundary.sql.includes('alter default privileges in schema public'),
  'Server-only data access, internal RPC denial, or same-owner constraints are incomplete.'
);
assert(
  accountLifecycle.sql.includes('activate_goalflow_email_beta')
    && accountLifecycle.sql.includes('goalflow_account_protocol_version')
    && accountLifecycle.sql.includes('email_confirmed_at is not null')
    && accountLifecycle.sql.includes("attempt.state = 'used'")
    && accountLifecycle.sql.includes('bootstrap_goalflow_owner')
    && accountLifecycle.sql.includes('goalflow_session_is_active')
    && accountLifecycle.sql.includes('from auth.sessions'),
  'Atomic invite activation, verified owner bootstrap, or session revocation support is incomplete.'
);
assert(
  emailOtpActivation.sql.includes('create table public.email_otp_attempts')
    && emailOtpActivation.sql.includes('token_hash text not null unique')
    && emailOtpActivation.sql.includes("interval '10 minutes'")
    && emailOtpActivation.sql.includes('captcha_token_hash')
    && emailOtpActivation.sql.includes('captcha_verified_at')
    && emailOtpActivation.sql.includes('request_ip_hash')
    && emailOtpActivation.sql.includes('goalflow_create_email_otp_attempt')
    && emailOtpActivation.sql.includes('pg_advisory_xact_lock')
    && emailOtpActivation.sql.includes('goalflow_mark_email_otp_delivery')
    && emailOtpActivation.sql.includes('activate_goalflow_email_otp')
    && emailOtpActivation.sql.includes('email_confirmed_at is not null')
    && emailOtpActivation.sql.includes('auth_user_id = target_user_id')
    && emailOtpActivation.sql.includes('auth_session_id = target_session_id')
    && emailOtpActivation.sql.includes('target_authenticated_at < attempt.created_at')
    && emailOtpActivation.sql.includes('revoke all on function public.activate_goalflow_email_beta')
    && !emailOtpActivation.sql.includes('user_metadata'),
  'Typed OTP binding, rate limits, one-use activation, or metadata retirement is incomplete.'
);
assert(
  realtimeSyncWakeup.sql.includes('create table if not exists public.sync_wakeup_state')
    && realtimeSyncWakeup.sql.includes('alter table public.sync_wakeup_state force row level security')
    && realtimeSyncWakeup.sql.includes('grant select on table public.sync_wakeup_state to authenticated')
    && realtimeSyncWakeup.sql.includes('(select auth.uid()) = user_id')
    && realtimeSyncWakeup.sql.includes('create or replace function public.tsurfing_signal_sync_wakeup')
    && realtimeSyncWakeup.sql.includes('security definer')
    && realtimeSyncWakeup.sql.includes('set search_path = pg_catalog')
    && realtimeSyncWakeup.sql.includes("'{}'::jsonb")
    && realtimeSyncWakeup.sql.includes("'sync_wakeup'")
    && realtimeSyncWakeup.sql.includes("'tsurfing:user:' || target_user_id::text")
    && realtimeSyncWakeup.sql.includes('after insert or update or delete on public.sync_records')
    && realtimeSyncWakeup.sql.includes('create policy "users receive own sync wakeups"')
    && realtimeSyncWakeup.sql.includes('(select realtime.topic()) =')
    && realtimeSyncWakeup.sql.includes("realtime.messages.extension = 'broadcast'")
    && !/create\s+policy[\s\S]{0,160}?for\s+insert[\s\S]{0,160}?to\s+authenticated/i.test(realtimeSyncWakeup.sql),
  'Transactional payload-free wake-up, exact private topic authorization, or client forgery denial is incomplete.'
);
const advisorHardeningWithoutBodies = databaseAdvisorHardening.sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BODY$$').toLowerCase();
for (const forbidden of [/\bdrop\s+table\b/, /\btruncate\b/, /\bdrop\s+column\b/, /\bdelete\s+from\b/]) {
  assert(
    !forbidden.test(advisorHardeningWithoutBodies),
    `Database advisor hardening migration contains destructive SQL: ${forbidden}.`
  );
}
assert(
  databaseAdvisorHardening.sql.includes('alter function public.validate_goalflow_task_schedule()')
    && databaseAdvisorHardening.sql.includes('set search_path = pg_catalog')
    && (databaseAdvisorHardening.sql.match(/\(select auth\.uid\(\)\)/g) ?? []).length === 14
    && (databaseAdvisorHardening.sql.match(/create index if not exists/g) ?? []).length === 15,
  'Fixed search path, cached ownership checks, or foreign-key indexes are incomplete.'
);
const backupWithoutBodies = backupHardening.sql.replace(/\$\$[\s\S]*?\$\$/g, '$$BODY$$').toLowerCase();
for (const forbidden of [/\bdrop\s+table\b/, /\btruncate\b/, /\bdrop\s+column\b/, /\bdelete\s+from\b/]) {
  assert(!forbidden.test(backupWithoutBodies), `Backup hardening migration contains destructive top-level SQL: ${forbidden}.`);
}
assert(
  backupHardening.sql.includes('add column if not exists encryption_version')
    && backupHardening.sql.includes("backup_kind in ('daily', 'weekly', 'pre-restore')")
    && backupHardening.sql.includes('goalflow_backup_protocol_version')
    && backupHardening.sql.includes("'ai_usage'")
    && backupHardening.sql.includes('validate_goalflow_backup_v2')
    && backupHardening.sql.includes('restore_goalflow_backup_v2')
    && backupHardening.sql.includes("jsonb_typeof(collections->collection_name) is distinct from 'array'")
    && backupHardening.sql.includes('revoke all on function public.restore_goalflow_backup(uuid, jsonb)')
    && backupHardening.sql.includes('greatest(current_usage.request_count, excluded.request_count)'),
  'Per-user backup protocol metadata, dry-run validation, or non-rewindable quota recovery is incomplete.'
);
assert(
  telegramCaptureConfirmation.sql.includes('goalflow_confirm_telegram_capture')
    && telegramCaptureConfirmation.sql.includes('for update')
    && telegramCaptureConfirmation.sql.includes("status = 'active'")
    && telegramCaptureConfirmation.sql.includes('goalflow_create_task_idempotent')
    && telegramCaptureConfirmation.sql.includes("set state = 'confirmed'")
    && telegramCaptureConfirmation.sql.includes('get diagnostics changed_rows = row_count')
    && telegramCaptureConfirmation.sql.includes('revoke all on function public.goalflow_confirm_telegram_capture')
    && telegramCaptureConfirmation.sql.includes('to service_role'),
  'Telegram task creation and capture confirmation are not atomic and server-only.'
);

process.stdout.write(JSON.stringify({
  status: 'PASS',
  migrations: files.length,
  emptySchemaOrder: 'PASS',
  existingSchemaAdditiveSafety: 'PASS',
  accessBoundary: 'PASS',
  note: 'Static verification only; PostgreSQL execution still requires a live/staging Supabase drill.'
}) + '\n');
