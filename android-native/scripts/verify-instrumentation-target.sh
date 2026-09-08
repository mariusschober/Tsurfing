#!/usr/bin/env bash
set -euo pipefail

test_package="${1:-}"
target_package="${2:-}"
runner="${3:-androidx.test.runner.AndroidJUnitRunner}"

package_pattern='^[A-Za-z][A-Za-z0-9_.]*$'
if [[ ! "$test_package" =~ $package_pattern || ! "$target_package" =~ $package_pattern || ! "$runner" =~ $package_pattern ]]; then
  echo 'INSTRUMENTATION_TARGET=FAIL (invalid package or runner identity)' >&2
  exit 1
fi

# `pm list instrumentation <target>` is authoritative for the installed APK.
# Require one exact binding so a missing, stale, or ambiguously targeted test
# package can never seed a different application's Room database.
listing="$(cat)"
expected="instrumentation:$test_package/$runner (target=$target_package)"
if [[ "$listing" != "$expected" ]]; then
  echo 'INSTRUMENTATION_TARGET=FAIL (installed test target is missing or ambiguous)' >&2
  exit 1
fi

echo 'INSTRUMENTATION_TARGET=PASS'
