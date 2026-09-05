#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
verifier="$repo_root/android-native/scripts/verify-instrumentation-target.sh"
upgrade="$repo_root/android-native/scripts/test-upgrade-matrix.sh"
test_package='com.example.goalflow.test'
target_package='com.example.goalflow'
runner='androidx.test.runner.AndroidJUnitRunner'
valid="instrumentation:$test_package/$runner (target=$target_package)"

printf '%s\n' "$valid" | "$verifier" "$test_package" "$target_package" "$runner" >/dev/null

assert_rejected() {
  label="$1"
  value="$2"
  if printf '%s\n' "$value" | "$verifier" "$test_package" "$target_package" "$runner" >/dev/null 2>&1; then
    echo "Instrumentation verifier accepted $label metadata." >&2
    exit 1
  fi
}

assert_rejected missing ''
assert_rejected wrong-target \
  "instrumentation:$test_package/$runner (target=com.example.other)"
assert_rejected ambiguous "$valid
instrumentation:com.example.second/$runner (target=$target_package)"

grep -F 'shell pm list instrumentation "$old_package"' "$upgrade" >/dev/null
if grep -F "targetPackage='" "$upgrade" >/dev/null; then
  echo 'Upgrade gate must not depend on optional aapt badging instrumentation metadata.' >&2
  exit 1
fi

printf '%s\n' 'INSTRUMENTATION_TARGET_REGRESSION=PASS'
