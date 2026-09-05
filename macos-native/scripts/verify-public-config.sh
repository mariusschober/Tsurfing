#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
mac_root="$repo_root/macos-native"
info_plist="$mac_root/GoalflowMac/Resources/Info.plist"

fail() {
  echo "macOS public configuration gate failed: $1" >&2
  exit 1
}

if command -v rg >/dev/null 2>&1; then
  if rg -l --hidden --glob '*.plist' --glob '*.xcconfig' --glob '*.entitlements' \
    '(?i)(sb_secret_[A-Za-z0-9_-]{20,}|SUPABASE_(SERVICE_ROLE|SECRET_KEY)[[:space:]]*=)' \
    "$mac_root" >/dev/null; then
    fail "a server-only Supabase credential pattern is present in distributable configuration"
  fi
  rg -q '<key>SUPABASE_PUBLISHABLE_KEY</key><string>\$\(SUPABASE_PUBLISHABLE_KEY\)</string>' "$info_plist" \
    || fail "Info.plist does not use the public publishable-key build setting"
  rg -q '<key>API_ORIGIN</key><string>\$\(API_ORIGIN\)</string>' "$info_plist" \
    || fail "Info.plist does not use the API-origin build setting"
  if rg -q 'local-demo|LocalDemoSyncTransport' "$mac_root/GoalflowMac" --glob '*.swift'; then
    fail "production macOS source contains a silent demo synchronization fallback"
  fi
  if rg -q '/Users/' "$mac_root/GoalflowMacTests" --glob '*.swift'; then
    fail "macOS tests depend on a developer-machine absolute path"
  fi
  rg -q 'tsurfing://auth/callback' "$mac_root/GoalflowMac/Sync/SyncTransport.swift" \
    || fail "the exact PKCE callback contract is missing"
  rg -q 'code_challenge_method.*s256' "$mac_root/GoalflowMac/Services/SupabaseAuthService.swift" \
    || fail "the PKCE S256 contract is missing"
else
  config_match=false
  while IFS= read -r file; do
    if grep -Eqi 'sb_secret_[A-Za-z0-9_-]{20,}|SUPABASE_(SERVICE_ROLE|SECRET_KEY)[[:space:]]*=' "$file"; then
      config_match=true
      break
    fi
  done < <(find "$mac_root" -type f \( -name '*.plist' -o -name '*.xcconfig' -o -name '*.entitlements' \) -print)
  [ "$config_match" = false ] || fail "a server-only Supabase credential pattern is present in distributable configuration"
  grep -Fq '<key>SUPABASE_PUBLISHABLE_KEY</key><string>$(SUPABASE_PUBLISHABLE_KEY)</string>' "$info_plist" \
    || fail "Info.plist does not use the public publishable-key build setting"
  grep -Fq '<key>API_ORIGIN</key><string>$(API_ORIGIN)</string>' "$info_plist" \
    || fail "Info.plist does not use the API-origin build setting"
  demo_match=false
  while IFS= read -r file; do
    if grep -Eq 'local-demo|LocalDemoSyncTransport' "$file"; then
      demo_match=true
      break
    fi
  done < <(find "$mac_root/GoalflowMac" -type f -name '*.swift' -print)
  [ "$demo_match" = false ] || fail "production macOS source contains a silent demo synchronization fallback"
  path_match=false
  while IFS= read -r file; do
    if grep -Fq '/Users/' "$file"; then
      path_match=true
      break
    fi
  done < <(find "$mac_root/GoalflowMacTests" -type f -name '*.swift' -print)
  [ "$path_match" = false ] || fail "macOS tests depend on a developer-machine absolute path"
  grep -Fq 'tsurfing://auth/callback' "$mac_root/GoalflowMac/Sync/SyncTransport.swift" \
    || fail "the exact PKCE callback contract is missing"
  grep -Eq 'code_challenge_method.*s256' "$mac_root/GoalflowMac/Services/SupabaseAuthService.swift" \
    || fail "the PKCE S256 contract is missing"
fi

echo "macOS public configuration gate PASS"
