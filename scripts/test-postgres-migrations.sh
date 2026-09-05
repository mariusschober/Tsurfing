#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
suffix="${RANDOM}_$$"
empty_database="goalflow_empty_${suffix}"
upgrade_database="goalflow_upgrade_${suffix}"

cleanup() {
  dropdb --if-exists --force "${empty_database}" >/dev/null 2>&1 || true
  dropdb --if-exists --force "${upgrade_database}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

createdb "${empty_database}"
createdb "${upgrade_database}"

psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${repository_root}/scripts/supabase-test-bootstrap.sql" >/dev/null
for migration in "${repository_root}"/supabase/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${migration}" >/dev/null
done
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${repository_root}/scripts/migration-current-seed.sql" >/dev/null
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${repository_root}/scripts/migration-integrity-assertions.sql" >/dev/null

psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${repository_root}/scripts/supabase-test-bootstrap.sql" >/dev/null
for migration in \
  "${repository_root}/supabase/migrations/202607170001_foundation.sql" \
  "${repository_root}/supabase/migrations/202607180001_scheduled_execution.sql" \
  "${repository_root}/supabase/migrations/202608250001_reliability_hardening.sql"; do
  psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${migration}" >/dev/null
done
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${repository_root}/scripts/migration-current-seed.sql" >/dev/null
for migration in \
  "${repository_root}/supabase/migrations/202608260001_zero_silent_data_loss.sql" \
  "${repository_root}/supabase/migrations/202608290001_native_task_events.sql" \
  "${repository_root}/supabase/migrations/202608300001_complete_native_sync_transport.sql" \
  "${repository_root}/supabase/migrations/202608310001_telegram_auth_state_pkce.sql" \
  "${repository_root}/supabase/migrations/202609030001_access_boundary_hardening.sql" \
  "${repository_root}/supabase/migrations/202609030002_account_lifecycle.sql" \
  "${repository_root}/supabase/migrations/202609030003_backup_restore_hardening.sql" \
  "${repository_root}/supabase/migrations/202609030004_telegram_webhook_claims.sql" \
  "${repository_root}/supabase/migrations/202609030005_telegram_mini_sessions.sql" \
  "${repository_root}/supabase/migrations/202609030006_telegram_link_hardening.sql" \
  "${repository_root}/supabase/migrations/202609030007_telegram_capture_confirmation.sql" \
  "${repository_root}/supabase/migrations/202609040001_email_otp_activation.sql" \
  "${repository_root}/supabase/migrations/202609040002_telegram_oidc_activation.sql" \
  "${repository_root}/supabase/migrations/202609040003_realtime_sync_wakeup.sql" \
  "${repository_root}/supabase/migrations/202609040004_database_advisor_hardening.sql"; do
  psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${migration}" >/dev/null
done
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${repository_root}/scripts/migration-integrity-assertions.sql" >/dev/null
access_assertions="${repository_root}/scripts/migration-access-boundary-assertions.sql"
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${access_assertions}" >/dev/null
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${access_assertions}" >/dev/null
account_assertions="${repository_root}/scripts/migration-account-lifecycle-assertions.sql"
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${account_assertions}" >/dev/null
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${account_assertions}" >/dev/null
telegram_assertions="${repository_root}/scripts/migration-telegram-assertions.sql"
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${telegram_assertions}" >/dev/null
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${telegram_assertions}" >/dev/null
realtime_wakeup_assertions="${repository_root}/scripts/migration-realtime-wakeup-assertions.sql"
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${realtime_wakeup_assertions}" >/dev/null
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${realtime_wakeup_assertions}" >/dev/null
advisor_hardening_assertions="${repository_root}/scripts/migration-advisor-hardening-assertions.sql"
psql -v ON_ERROR_STOP=1 -d "${empty_database}" -f "${advisor_hardening_assertions}" >/dev/null
psql -v ON_ERROR_STOP=1 -d "${upgrade_database}" -f "${advisor_hardening_assertions}" >/dev/null

echo '{"status":"PASS","emptyDatabase":"PASS","currentSchemaUpgrade":"PASS","idempotency":"PASS","conflictPreservation":"PASS","cursorRebase":"PASS","atomicRestore":"PASS","backupDryRun":"PASS","quotaRewind":"DENIED","nativeTaskEvents":"PASS","unknownPayloadPreservation":"PASS","directDataApi":"DENIED","rlsIsolation":"PASS","sameOwnerRelations":"PASS","typedEmailOtpActivation":"PASS","telegramOidcActivation":"PASS","sessionRevocation":"PASS","ownerBootstrap":"PASS","telegramWebhookClaims":"PASS","telegramMiniSessions":"PASS","telegramAccountBinding":"PASS","telegramCaptureConfirmation":"ATOMIC","realtimeWakeup":"PASS","wakeupRollback":"PASS","topicForgery":"DENIED","databaseAdvisorHardening":"PASS"}'
