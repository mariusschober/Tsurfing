#!/usr/bin/env bash
set -euo pipefail

if [[ "${GOALFLOW_ALLOW_TEST_APP_DATA_ERASE:-0}" != "1" ]]; then
  echo 'INSTRUMENTATION_APK=FAIL (test-device operations were not explicitly authorized)' >&2
  exit 1
fi

app_apk="${1:-}"
test_apk="${2:-}"
expected_count="${3:-}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
[[ -n "$app_apk" && -f "$app_apk" ]] || { echo 'INSTRUMENTATION_APK=FAIL (application APK is missing)' >&2; exit 1; }
[[ -n "$test_apk" && -f "$test_apk" ]] || { echo 'INSTRUMENTATION_APK=FAIL (test APK is missing)' >&2; exit 1; }
[[ "$expected_count" =~ ^[1-9][0-9]*$ ]] || { echo 'INSTRUMENTATION_APK=FAIL (expected test count is invalid)' >&2; exit 1; }

sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
aapt_bin=""
if command -v aapt >/dev/null 2>&1; then
  aapt_bin="$(command -v aapt)"
elif [[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]]; then
  while IFS= read -r candidate; do
    [[ -x "$candidate" ]] && aapt_bin="$candidate"
  done < <(find "$sdk_root/build-tools" -type f -name aapt -print 2>/dev/null | sort -V)
fi
[[ -n "$aapt_bin" ]] || { echo 'INSTRUMENTATION_APK=FAIL (aapt unavailable)' >&2; exit 1; }
adb_bin="$(command -v adb || true)"
[[ -n "$adb_bin" ]] || { echo 'INSTRUMENTATION_APK=FAIL (adb unavailable)' >&2; exit 1; }
timeout_bin="$(command -v timeout || true)"
[[ -n "$timeout_bin" ]] || { echo 'INSTRUMENTATION_APK=FAIL (timeout unavailable)' >&2; exit 1; }

adb_command=("$adb_bin")
if [[ -n "${GOALFLOW_ANDROID_SERIAL:-}" ]]; then
  adb_command+=( -s "$GOALFLOW_ANDROID_SERIAL" )
fi
[[ "$("${adb_command[@]}" get-state 2>/dev/null || true)" == device ]] || {
  echo 'INSTRUMENTATION_APK=FAIL (test device unavailable)' >&2
  exit 1
}

app_badging="$("$aapt_bin" dump badging "$app_apk")"
test_badging="$("$aapt_bin" dump badging "$test_apk")"
app_package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$app_badging")"
test_package="$(sed -n "s/^package: name='\([^']*\)'.*/\1/p" <<<"$test_badging")"
package_pattern='^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$'
if [[ ! "$app_package" =~ $package_pattern || ! "$test_package" =~ $package_pattern || "$app_package" == "$test_package" ]]; then
  echo 'INSTRUMENTATION_APK=FAIL (application/test package identity is missing or ambiguous)' >&2
  exit 1
fi

runner='androidx.test.runner.AndroidJUnitRunner'
"${adb_command[@]}" install -r "$app_apk" >/dev/null
"${adb_command[@]}" install "$test_apk" >/dev/null
installed_instrumentation="$("${adb_command[@]}" shell pm list instrumentation "$app_package" | tr -d '\r')"
printf '%s\n' "$installed_instrumentation" | \
  "$script_dir/verify-instrumentation-target.sh" "$test_package" "$app_package" "$runner"

instrumentation_output="$("$timeout_bin" 300 "${adb_command[@]}" shell am instrument -w "$test_package/$runner" | tr -d '\r')"
if ! grep -Fxq "OK ($expected_count tests)" <<<"$instrumentation_output"; then
  printf '%s\n' "$instrumentation_output" >&2
  echo 'INSTRUMENTATION_APK=FAIL (instrumentation result or test count mismatch)' >&2
  exit 1
fi
"${adb_command[@]}" uninstall "$test_package" >/dev/null

echo "INSTRUMENTATION_TESTS=$expected_count"
echo 'INSTRUMENTATION_APK=PASS'
