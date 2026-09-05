#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "macOS bundle key gate failed: $1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "expected exactly one .app bundle path"
app_path="$1"
info_plist="$app_path/Contents/Info.plist"

[ -d "$app_path" ] || fail "application bundle does not exist"
[ -f "$info_plist" ] || fail "application bundle has no Info.plist"
command -v plutil >/dev/null 2>&1 || fail "plutil is required"

if ! publishable_key="$(plutil -extract SUPABASE_PUBLISHABLE_KEY raw -o - "$info_plist" 2>/dev/null)"; then
  fail "the public key could not be read from the application Info.plist"
fi

# An unconfigured development build is valid and remains explicitly disconnected.
if [ -z "$publishable_key" ]; then
  echo "macOS bundle key gate PASS (unconfigured)"
  exit 0
fi

case "$publishable_key" in
  sb_publishable_*)
    [ "${#publishable_key}" -ge 24 ] || fail "the current publishable key is malformed"
    echo "macOS bundle key gate PASS"
    exit 0
    ;;
  sb_secret_*)
    fail "a current server-only Supabase key reached the application bundle"
    ;;
esac

IFS='.' read -r -a jwt_parts <<< "$publishable_key"
[ "${#jwt_parts[@]}" -eq 3 ] || fail "the configured key is neither publishable nor a legacy JWT"
[ -n "${jwt_parts[0]}" ] && [ -n "${jwt_parts[1]}" ] && [ -n "${jwt_parts[2]}" ] \
  || fail "the configured legacy JWT is malformed"

encoded_payload="$(printf '%s' "${jwt_parts[1]}" | tr '_-' '/+')"
case $((${#encoded_payload} % 4)) in
  0) ;;
  2) encoded_payload="${encoded_payload}==" ;;
  3) encoded_payload="${encoded_payload}=" ;;
  *) fail "the configured legacy JWT payload is malformed" ;;
esac

payload_file="$(mktemp "${TMPDIR:-/tmp}/goalflow-key-payload.XXXXXX")"
cleanup() {
  rm -f "$payload_file"
}
trap cleanup EXIT
chmod 600 "$payload_file"

printf '%s' "$encoded_payload" | openssl base64 -d -A > "$payload_file" 2>/dev/null \
  || fail "the configured legacy JWT payload cannot be decoded"
if ! legacy_role="$(plutil -extract role raw -o - "$payload_file" 2>/dev/null)"; then
  fail "the configured legacy JWT payload has no readable top-level role"
fi
[ "$legacy_role" = "anon" ] \
  || fail "the configured legacy JWT is not an anonymous client key"

echo "macOS bundle key gate PASS"
