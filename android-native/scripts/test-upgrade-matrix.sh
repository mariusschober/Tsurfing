#!/usr/bin/env bash
set -euo pipefail

# This command upgrades a historical v2 schema fixture in place. CI rebuilds
# that exact historical source under the new Tsurfing application ID because
# no Goalflow package was distributed. A test APK seeds its real Room database;
# after Android installs the current APK with -r, the database is copied from
# the stopped debug application and verified byte-for-byte through SQLite.
if [[ "${GOALFLOW_ALLOW_TEST_APP_DATA_ERASE:-0}" != "1" ]]; then
  echo 'UPGRADE_MATRIX=FAIL (set GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 only on a nonproduction test device)' >&2
  exit 1
fi

old_apk="${1:-${GOALFLOW_UPGRADE_FROM_APK:-}}"
new_apk="${2:-android-native/app/build/outputs/apk/production/release/app-production-release.apk}"
old_test_apk="${3:-${GOALFLOW_UPGRADE_SEED_TEST_APK:-}}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -n "$old_apk" && -f "$old_apk" ]] || { echo 'UPGRADE_MATRIX=FAIL (a historical prior-schema fixture APK is required)' >&2; exit 1; }
[[ -f "$new_apk" ]] || { echo "UPGRADE_MATRIX=FAIL (new APK missing: $new_apk)" >&2; exit 1; }
[[ -n "$old_test_apk" && -f "$old_test_apk" ]] || { echo 'UPGRADE_MATRIX=FAIL (the preserved-version seed test APK is required)' >&2; exit 1; }

sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
aapt_bin=""
if command -v aapt >/dev/null 2>&1; then
  aapt_bin="$(command -v aapt)"
elif [[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]]; then
  while IFS= read -r candidate; do
    [[ -x "$candidate" ]] && aapt_bin="$candidate"
  done < <(find "$sdk_root/build-tools" -type f -name aapt -print 2>/dev/null | sort -V)
fi
[[ -n "$aapt_bin" ]] || { echo 'UPGRADE_MATRIX=FAIL (aapt unavailable)' >&2; exit 1; }
sqlite3_bin="$(command -v sqlite3 || true)"
[[ -n "$sqlite3_bin" ]] || { echo 'UPGRADE_MATRIX=FAIL (sqlite3 unavailable for durable-data verification)' >&2; exit 1; }
adb_bin="$(command -v adb || true)"
[[ -n "$adb_bin" ]] || { echo 'UPGRADE_MATRIX=FAIL (adb unavailable)' >&2; exit 1; }
adb_command=("$adb_bin")
if [[ -n "${GOALFLOW_ANDROID_SERIAL:-}" ]]; then
  adb_command+=( -s "$GOALFLOW_ANDROID_SERIAL" )
fi
[[ "$("${adb_command[@]}" get-state 2>/dev/null || true)" == device ]] || {
  echo 'UPGRADE_MATRIX=FAIL (test device unavailable)' >&2
  exit 1
}

old_badging="$("$aapt_bin" dump badging "$old_apk")"
new_badging="$("$aapt_bin" dump badging "$new_apk")"
old_package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$old_badging")"
new_package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$new_badging")"
test_badging="$("$aapt_bin" dump badging "$old_test_apk")"
test_package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$test_badging")"
# Build-tools may omit instrumentation attributes from badging output. Verify
# the installed component-to-target binding through Package Manager below.
old_version="$(sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" <<<"$old_badging")"
new_version="$(sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" <<<"$new_badging")"

[[ -n "$old_package" && "$old_package" == "$new_package" ]] || {
  echo "UPGRADE_MATRIX=FAIL (fixture package mismatch: ${old_package:-unknown} -> ${new_package:-unknown})" >&2
  exit 1
}
[[ -n "$test_package" && "$test_package" != "$old_package" ]] || {
  echo 'UPGRADE_MATRIX=FAIL (seed test package identity is missing or ambiguous)' >&2
  exit 1
}
[[ "$old_version" =~ ^[0-9]+$ && "$new_version" =~ ^[0-9]+$ && "$old_version" -lt "$new_version" ]] || {
  echo "UPGRADE_MATRIX=FAIL (versionCode must increase: ${old_version:-unknown} -> ${new_version:-unknown})" >&2
  exit 1
}

"${adb_command[@]}" uninstall "$old_package" >/dev/null 2>&1 || true
"${adb_command[@]}" install "$old_apk" >/dev/null
"${adb_command[@]}" install "$old_test_apk" >/dev/null
installed_instrumentation="$("${adb_command[@]}" shell pm list instrumentation "$old_package" | tr -d '\r')"
printf '%s\n' "$installed_instrumentation" | \
  "$script_dir/verify-instrumentation-target.sh" \
    "$test_package" "$old_package" androidx.test.runner.AndroidJUnitRunner
seed_output="$("${adb_command[@]}" shell am instrument -w \
  -e class com.mariusschober.goalflow.nativeapp.data.PriorInstallUpgradeSeedTest \
  "$test_package/androidx.test.runner.AndroidJUnitRunner")"
grep -Fq 'OK (1 test)' <<<"$seed_output" || {
  printf '%s\n' "$seed_output" >&2
  echo 'UPGRADE_MATRIX=FAIL (preserved-version Room seed failed)' >&2
  exit 1
}
"${adb_command[@]}" uninstall "$test_package" >/dev/null
"$script_dir/verify-installed-app-launch.sh" \
  "$old_package" com.mariusschober.goalflow.nativeapp.MainActivity UPGRADE_PRESERVED_LAUNCH
"${adb_command[@]}" shell am force-stop "$old_package"
"${adb_command[@]}" install -r "$new_apk" >/dev/null
"$script_dir/verify-installed-app-launch.sh" \
  "$new_package" com.mariusschober.goalflow.nativeapp.MainActivity UPGRADE_CURRENT_LAUNCH
"${adb_command[@]}" shell am force-stop "$new_package"

probe_dir="$(mktemp -d)"
database_copy="$probe_dir/goalflow-native.db"
"${adb_command[@]}" exec-out run-as "$new_package" cat databases/goalflow-native.db >"$database_copy"
[[ -s "$database_copy" ]] || { echo 'UPGRADE_MATRIX=FAIL (upgraded Room database could not be read)' >&2; exit 1; }
for suffix in -wal -shm; do
  if ! "${adb_command[@]}" exec-out run-as "$new_package" cat "databases/goalflow-native.db$suffix" \
      >"$database_copy$suffix" 2>/dev/null || [[ ! -s "$database_copy$suffix" ]]; then
    rm -f "$database_copy$suffix"
  fi
done

expect_query() {
  local label="$1"
  local sql="$2"
  local expected="$3"
  local actual
  actual="$("$sqlite3_bin" -batch -noheader "$database_copy" "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "UPGRADE_MATRIX=FAIL ($label changed across upgrade)" >&2
    exit 1
  fi
}

active_task='11111111-1111-4111-8111-111111111111'
deleted_task='22222222-2222-4222-8222-222222222222'
first_mutation='33333333-3333-4333-8333-333333333333'
second_mutation='44444444-4444-4444-8444-444444444444'
delete_mutation='55555555-5555-4555-8555-555555555555'
account_id='66666666-6666-4666-8666-666666666666'

expect_query integrity 'PRAGMA quick_check' 'ok'
expect_query room-version 'PRAGMA user_version' '8'
expect_query task-count 'SELECT COUNT(*) FROM tasks' '2'
expect_query active-task \
  "SELECT id||'|'||title||'|'||notes||'|'||schedulePrecision||'|'||scheduledFor||'|'||scheduledTime||'|'||plannedOrder||'|'||isFrog||'|'||frogFailures||'|'||createdAt||'|'||updatedAt||'|'||extraJson FROM tasks WHERE id='$active_task'" \
  "$active_task|Upgrade sentinel|created by preserved v2|DAY|2026-08-27|09:30|7|1|2|1722470400000|1722470460000|{\"duration\":35}"
expect_query deleted-task \
  "SELECT id||'|'||status||'|'||updatedAt||'|'||deletedAt FROM tasks WHERE id='$deleted_task'" \
  "$deleted_task|DROPPED|1722470560000|1722470600000"
expect_query outbox-count 'SELECT COUNT(*) FROM sync_outbox' '3'
expect_query first-mutation \
  "SELECT mutationId||'|'||deviceId||'|'||entityId||'|'||version||'|'||updatedAt FROM sync_outbox WHERE mutationId='$first_mutation'" \
  "$first_mutation|upgrade-device-v2|$active_task|1|2026-08-27T00:00:00Z"
expect_query dependent-mutation \
  "SELECT mutationId||'|'||entityId||'|'||version||'|'||dependsOnMutationId FROM sync_outbox WHERE mutationId='$second_mutation'" \
  "$second_mutation|$active_task|2|$first_mutation"
expect_query delete-mutation \
  "SELECT mutationId||'|'||entityId||'|'||baseServerVersion||'|'||version||'|'||deletedAt FROM sync_outbox WHERE mutationId='$delete_mutation'" \
  "$delete_mutation|$deleted_task|4|5|2026-08-28T00:00:00Z"
expect_query sync-cursor \
  "SELECT cursor||'|'||localVersion||'|'||serverVersion||'|'||lastSuccessfulSync FROM sync_meta WHERE entityType='tasks:$active_task'" \
  '17|2|16|2026-08-26T23:59:00Z'
expect_query account-binding \
  "SELECT bindingKey||'|'||userId FROM local_account" \
  "owner|$account_id"

echo 'UPGRADE_INSTALL_LAUNCH=PASS'
echo 'UPGRADE_DATA_PRESERVATION=PASS'
echo "UPGRADE_PACKAGE=$new_package"
echo "UPGRADE_VERSION_CODES=$old_version->$new_version"
echo 'UPGRADE_SENTINELS=2_tasks,3_outbox,1_tombstone,1_dependency,1_account_binding'
echo 'UPGRADE_MATRIX=PASS'
