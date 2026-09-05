#!/usr/bin/env sh
set -eu

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
runner="$repo_root/android-native/scripts/run-instrumentation-apk.sh"
bin_dir="$work_dir/bin"
mkdir -p "$bin_dir"
app_apk="$work_dir/app.apk"
test_apk="$work_dir/test.apk"
record="$work_dir/record"
printf '%s\n' app >"$app_apk"
printf '%s\n' test >"$test_apk"

cat >"$bin_dir/aapt" <<'STUB'
#!/usr/bin/env sh
set -eu
case "$3" in
  */app.apk) printf "%s\n" "package: name='com.example.goalflow' versionCode='3'" ;;
  */test.apk) printf "%s\n" "package: name='com.example.goalflow.test' versionCode='3'" ;;
  *) exit 1 ;;
esac
STUB
cat >"$bin_dir/adb" <<'STUB'
#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >>"$GOALFLOW_TEST_RECORD"
case "$*" in
  'get-state') printf '%s\n' device ;;
  'install -r '*) printf '%s\n' Success ;;
  'install '*) printf '%s\n' Success ;;
  'shell pm list instrumentation com.example.goalflow')
    printf '%s\n' "instrumentation:com.example.goalflow.test/androidx.test.runner.AndroidJUnitRunner (target=${GOALFLOW_FAKE_TARGET:-com.example.goalflow})"
    ;;
  'shell am instrument -w com.example.goalflow.test/androidx.test.runner.AndroidJUnitRunner')
    printf '%s\n' "OK (${GOALFLOW_FAKE_TEST_COUNT:-7} tests)"
    ;;
  'uninstall com.example.goalflow.test') printf '%s\n' Success ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$bin_dir/aapt" "$bin_dir/adb"

if PATH="$bin_dir:$PATH" GOALFLOW_TEST_RECORD="$record" \
    "$runner" "$app_apk" "$test_apk" 7 >/dev/null 2>&1; then
  echo 'Instrumentation APK runner ignored its destructive test-device guard.' >&2
  exit 1
fi
[ ! -e "$record" ]

PATH="$bin_dir:$PATH" GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 GOALFLOW_TEST_RECORD="$record" \
  "$runner" "$app_apk" "$test_apk" 7 >"$work_dir/success"
grep -Fx 'INSTRUMENTATION_TARGET=PASS' "$work_dir/success" >/dev/null
grep -Fx 'INSTRUMENTATION_TESTS=7' "$work_dir/success" >/dev/null
grep -Fx 'INSTRUMENTATION_APK=PASS' "$work_dir/success" >/dev/null
grep -Fx 'shell am instrument -w com.example.goalflow.test/androidx.test.runner.AndroidJUnitRunner' "$record" >/dev/null

: >"$record"
if PATH="$bin_dir:$PATH" GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 \
    GOALFLOW_FAKE_TARGET=com.example.other GOALFLOW_TEST_RECORD="$record" \
    "$runner" "$app_apk" "$test_apk" 7 >/dev/null 2>&1; then
  echo 'Instrumentation APK runner accepted a wrong target.' >&2
  exit 1
fi
if grep -F 'shell am instrument' "$record" >/dev/null; then
  echo 'Instrumentation ran after target validation failed.' >&2
  exit 1
fi

: >"$record"
if PATH="$bin_dir:$PATH" GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 \
    GOALFLOW_FAKE_TEST_COUNT=6 GOALFLOW_TEST_RECORD="$record" \
    "$runner" "$app_apk" "$test_apk" 7 >/dev/null 2>&1; then
  echo 'Instrumentation APK runner accepted the wrong number of tests.' >&2
  exit 1
fi

printf '%s\n' 'INSTRUMENTATION_APK_RUNNER_REGRESSION=PASS'
