#!/usr/bin/env sh
set -eu

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
verifier="$repo_root/android-native/scripts/verify-installed-app-launch.sh"
bin_dir="$work_dir/bin"
record="$work_dir/record"
mkdir -p "$bin_dir"

cat >"$bin_dir/adb" <<'STUB'
#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >>"$GOALFLOW_TEST_RECORD"
case "$*" in
  'get-state') printf '%s\n' device ;;
  'shell am force-stop com.example.goalflow') ;;
  'shell am start -n com.example.goalflow/com.example.goalflow.MainActivity')
    printf '%s\n' 'Starting: Intent { cmp=com.example.goalflow/com.example.goalflow.MainActivity }'
    ;;
  'shell pidof com.example.goalflow')
    [ "${GOALFLOW_FAKE_PROCESS:-present}" = present ] && printf '%s\n' 1234
    ;;
  'shell dumpsys activity activities')
    printf '%s\n' "mResumedActivity: ActivityRecord{test ${GOALFLOW_FAKE_COMPONENT:-com.example.goalflow/com.example.goalflow.MainActivity}}"
    ;;
  'shell uiautomator dump /data/local/tmp/goalflow-TEST_LAUNCH.xml') ;;
  'shell cat /data/local/tmp/goalflow-TEST_LAUNCH.xml')
    if [ "${GOALFLOW_FAKE_UI:-expected}" = expected ]; then
      printf '%s\n' '<hierarchy><node text="Current" package="com.example.goalflow" /></hierarchy>'
    else
      printf '%s\n' '<hierarchy><node text="Other" package="com.example.other" /></hierarchy>'
    fi
    ;;
  'shell rm -f /data/local/tmp/goalflow-TEST_LAUNCH.xml') ;;
  'shell dumpsys gfxinfo com.example.goalflow')
    printf 'Total frames rendered: %s\n' "${GOALFLOW_FAKE_FRAMES:-0}"
    ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$bin_dir/adb"

if PATH="$bin_dir:$PATH" GOALFLOW_TEST_RECORD="$record" \
    "$verifier" com.example.goalflow com.example.goalflow.MainActivity >/dev/null 2>&1; then
  echo 'Installed app launch verifier ignored its test-device guard.' >&2
  exit 1
fi
[ ! -e "$record" ]

PATH="$bin_dir:$PATH" GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 \
GOALFLOW_LAUNCH_POLL_ATTEMPTS=1 GOALFLOW_TEST_RECORD="$record" \
  "$verifier" com.example.goalflow com.example.goalflow.MainActivity TEST_LAUNCH \
  >"$work_dir/success"
grep -Fx 'TEST_LAUNCH_UI=PASS' "$work_dir/success" >/dev/null
grep -Fx 'TEST_LAUNCH_GFX_FRAMES=0' "$work_dir/success" >/dev/null
grep -Fx 'TEST_LAUNCH=PASS' "$work_dir/success" >/dev/null
grep -Fx 'shell am force-stop com.example.goalflow' "$record" >/dev/null
grep -Fx 'shell am start -n com.example.goalflow/com.example.goalflow.MainActivity' "$record" >/dev/null

assert_rejected() {
  label="$1"
  shift
  : >"$record"
  if PATH="$bin_dir:$PATH" GOALFLOW_ALLOW_TEST_APP_DATA_ERASE=1 \
      GOALFLOW_LAUNCH_POLL_ATTEMPTS=1 GOALFLOW_TEST_RECORD="$record" \
      "$@" "$verifier" com.example.goalflow com.example.goalflow.MainActivity TEST_LAUNCH \
      >/dev/null 2>&1; then
    echo "Installed app launch verifier accepted $label state." >&2
    exit 1
  fi
}

assert_rejected missing-process env GOALFLOW_FAKE_PROCESS=absent
assert_rejected wrong-resumed-activity env \
  GOALFLOW_FAKE_COMPONENT=com.example.other/com.example.other.MainActivity
assert_rejected missing-visible-ui env GOALFLOW_FAKE_UI=other

printf '%s\n' 'INSTALLED_APP_LAUNCH_REGRESSION=PASS'
