#!/usr/bin/env sh
set -eu

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
workflow="$repo_root/.github/workflows/ci.yml"
driver="$repo_root/android-native/scripts/run-emulator-gate.sh"
[ -f "$workflow" ]
[ -x "$driver" ]

emulator_block="$(sed -n '/- name: Run native emulator journey/,/- name: Upload native production debug APK/p' "$workflow")"
[ -n "$emulator_block" ]
printf '%s\n' "$emulator_block" | grep -F 'working-directory: ${{ github.workspace }}' >/dev/null
printf '%s\n' "$emulator_block" | grep -F \
    'script: GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 android-native/scripts/run-emulator-gate.sh' >/dev/null
if printf '%s\n' "$emulator_block" | grep -F 'script: |' >/dev/null; then
    echo "The emulator action must receive one command; it executes multiline input in separate shells." >&2
    exit 1
fi
grep -Fx '#!/usr/bin/env bash' "$driver" >/dev/null
grep -Fx 'set -euo pipefail' "$driver" >/dev/null

workspace="$work_dir/workspace"
native_root="$workspace/android-native"
scripts="$native_root/scripts"
apk_dir="$native_root/app/build/outputs/apk/production/debug"
test_apk_dir="$native_root/app/build/outputs/apk/androidTest/production/debug"
mkdir -p "$scripts" "$apk_dir" "$test_apk_dir"
cp "$driver" "$scripts/run-emulator-gate.sh"
chmod +x "$scripts/run-emulator-gate.sh"

current_apk="$apk_dir/app-production-debug.apk"
current_test_apk="$test_apk_dir/app-production-debug-androidTest.apk"
old_apk="$work_dir/preserved-v2.apk"
old_test_apk="$work_dir/preserved-v2-androidTest.apk"
record="$work_dir/record"
printf '%s\n' current >"$current_apk"
printf '%s\n' current-test >"$current_test_apk"
printf '%s\n' old >"$old_apk"
printf '%s\n' old-test >"$old_test_apk"

cat >"$scripts/diagnose-apk.sh" <<'STUB'
#!/usr/bin/env sh
set -eu
printf 'diagnose|%s|%s|%s\n' "${GOALFLOW_APK_LABEL:-}" "${DIAGNOSE_APK_INSTALL:-}" "$1" >>"$GOALFLOW_TEST_RECORD"
STUB
cat >"$scripts/run-instrumentation-apk.sh" <<'STUB'
#!/usr/bin/env sh
set -eu
printf 'instrumentation|%s|%s|%s|%s\n' "${GOALFLOW_ALLOW_TEST_APP_DATA_ERASE:-}" "$1" "$2" "$3" >>"$GOALFLOW_TEST_RECORD"
STUB
cat >"$scripts/test-upgrade-matrix.sh" <<'STUB'
#!/usr/bin/env sh
set -eu
printf 'upgrade|%s|%s|%s|%s\n' "${GOALFLOW_ALLOW_TEST_APP_DATA_ERASE:-}" "$1" "$2" "$3" >>"$GOALFLOW_TEST_RECORD"
STUB
chmod +x "$scripts/diagnose-apk.sh" "$scripts/run-instrumentation-apk.sh" "$scripts/test-upgrade-matrix.sh"

if GITHUB_WORKSPACE="$workspace" \
    GOALFLOW_UPGRADE_FROM_APK="$old_apk" \
    GOALFLOW_UPGRADE_SEED_TEST_APK="$old_test_apk" \
    GOALFLOW_TEST_RECORD="$record" \
    "$scripts/run-emulator-gate.sh" >/dev/null 2>&1; then
    echo "The emulator driver ran without the destructive test-device guard." >&2
    exit 1
fi
[ ! -e "$record" ]

GITHUB_WORKSPACE="$workspace" \
GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 \
GOALFLOW_UPGRADE_FROM_APK="$old_apk" \
GOALFLOW_UPGRADE_SEED_TEST_APK="$old_test_apk" \
GOALFLOW_TEST_RECORD="$record" \
    "$scripts/run-emulator-gate.sh" >/dev/null

expected="$work_dir/expected"
printf 'diagnose|TEST-ONLY|1|%s\n' "$current_apk" >"$expected"
printf 'instrumentation|1|%s|%s|7\n' "$current_apk" "$current_test_apk" >>"$expected"
printf 'upgrade|1|%s|%s|%s\n' "$old_apk" "$current_apk" "$old_test_apk" >>"$expected"
cmp "$record" "$expected"

printf '%s\n' 'APK_PATH_HANDOFF=PASS'
