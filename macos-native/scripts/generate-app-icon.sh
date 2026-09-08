#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source_svg="$repo_root/public/icons/icon.svg"
asset_dir="$repo_root/macos-native/GoalflowMac/Resources/Assets.xcassets/AppIcon.appiconset"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/tsurfing-app-icon.XXXXXX")"

cleanup() {
  rm -rf -- "$temporary_dir"
}
trap cleanup EXIT

test -f "$source_svg"
test -f "$asset_dir/Contents.json"

qlmanage -t -s 1024 -o "$temporary_dir" "$source_svg" >/dev/null
rendered="$temporary_dir/$(basename "$source_svg").png"
test -f "$rendered"

sips -z 16 16 "$rendered" --out "$asset_dir/AppIcon-16.png" >/dev/null
sips -z 32 32 "$rendered" --out "$asset_dir/AppIcon-32.png" >/dev/null
sips -z 64 64 "$rendered" --out "$asset_dir/AppIcon-64.png" >/dev/null
sips -z 128 128 "$rendered" --out "$asset_dir/AppIcon-128.png" >/dev/null
sips -z 256 256 "$rendered" --out "$asset_dir/AppIcon-256.png" >/dev/null
sips -z 512 512 "$rendered" --out "$asset_dir/AppIcon.png" >/dev/null
cp "$rendered" "$asset_dir/AppIcon@2x.png"

echo "Generated the complete macOS Tsurfing iconset from public/icons/icon.svg."
