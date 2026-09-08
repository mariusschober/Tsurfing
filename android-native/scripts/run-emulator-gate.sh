#!/usr/bin/env bash
set -euo pipefail

# android-emulator-runner executes each newline from its `script` input in a
# separate POSIX shell. Keep the stateful gate in one checked-in Bash process
# so paths and fail-closed options cannot be lost between commands.
[[ "${GOALFLOW_ALLOW_TEST_APP_DATA_ERASE:-0}" == "1" ]] || {
  echo 'EMULATOR_GATE=FAIL (destructive test-device operations were not explicitly authorized)' >&2
  exit 1
}

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
native_root="$workspace/android-native"
export GOALFLOW_LAUNCH_DIAGNOSTICS_DIR="$native_root/build/launch-diagnostics"
current_apk="$native_root/app/build/outputs/apk/production/debug/app-production-debug.apk"
current_test_apk="$native_root/app/build/outputs/apk/androidTest/production/debug/app-production-debug-androidTest.apk"
old_apk="${GOALFLOW_UPGRADE_FROM_APK:?GOALFLOW_UPGRADE_FROM_APK is required}"
old_test_apk="${GOALFLOW_UPGRADE_SEED_TEST_APK:?GOALFLOW_UPGRADE_SEED_TEST_APK is required}"

[[ -f "$current_apk" ]] || {
  echo 'EMULATOR_GATE=FAIL (current production debug APK is missing)' >&2
  exit 1
}
[[ -f "$current_test_apk" ]] || {
  echo 'EMULATOR_GATE=FAIL (current production instrumentation APK is missing)' >&2
  exit 1
}
[[ -f "$old_apk" ]] || {
  echo 'EMULATOR_GATE=FAIL (preserved v2 APK is missing)' >&2
  exit 1
}
[[ -f "$old_test_apk" ]] || {
  echo 'EMULATOR_GATE=FAIL (preserved v2 seed test APK is missing)' >&2
  exit 1
}

GOALFLOW_APK_LABEL=TEST-ONLY DIAGNOSE_APK_INSTALL=1 \
  "$native_root/scripts/diagnose-apk.sh" "$current_apk"
"$native_root/scripts/run-instrumentation-apk.sh" "$current_apk" "$current_test_apk" 7
"$native_root/scripts/test-upgrade-matrix.sh" "$old_apk" "$current_apk" "$old_test_apk"

echo 'EMULATOR_GATE=PASS'
