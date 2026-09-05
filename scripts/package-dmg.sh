#!/usr/bin/env bash
set -euo pipefail

# Package Tsurfing as either an explicitly ad-hoc local beta or a
# Developer-ID-signed build. Every requested stage is mandatory: this script
# never substitutes a stale artifact or reports success after a failed command.
# Usage: ./scripts/package-dmg.sh [version] [team_id] [notary_keychain_profile]

VERSION=${1:-0.4.0}
TEAM_ID=${2:-}
NOTARY_PROFILE=${3:-}

if [[ ! "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.-]{0,40}$ ]]; then
  echo "Version must contain only letters, numbers, dots, and hyphens." >&2
  exit 2
fi
if [[ -n "$TEAM_ID" && ! "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "Apple Developer Team ID must be exactly 10 uppercase letters or digits." >&2
  exit 2
fi
if [[ -n "$NOTARY_PROFILE" && ! "$NOTARY_PROFILE" =~ ^[0-9A-Za-z._-]+$ ]]; then
  echo "Notary keychain profile contains unsupported characters." >&2
  exit 2
fi
if [[ -n "$NOTARY_PROFILE" && -z "$TEAM_ID" ]]; then
  echo "Notarization requires a Developer-ID-signed build and Team ID." >&2
  exit 2
fi

PROJECT="macos-native/GoalflowMac.xcodeproj"
SCHEME="GoalflowMac"
ARCHIVE="build/GoalflowMac.xcarchive"
EXPORT_DIR="build/Export"
APP="$EXPORT_DIR/Tsurfing.app"
DMG="build/Tsurfing-${VERSION}.dmg"
ENTITLEMENTS="macos-native/GoalflowMac/GoalflowMac.entitlements"
EXPORT_OPTIONS=""

cleanup() {
  if [[ -n "$EXPORT_OPTIONS" ]]; then
    rm -f -- "$EXPORT_OPTIONS"
  fi
}
trap cleanup EXIT

mkdir -p build
rm -rf -- "$ARCHIVE" "$EXPORT_DIR"
rm -f -- "$DMG" "$DMG.sha256" "$DMG.provenance.txt"

if [[ -n "$TEAM_ID" ]]; then
  echo "Building Developer-ID beta archive for version $VERSION"
  xcodebuild archive \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -archivePath "$ARCHIVE" \
    CODE_SIGN_STYLE=Automatic \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS"

  EXPORT_OPTIONS="$(mktemp "${TMPDIR:-/tmp}/goalflow-export-options.XXXXXX")"
  sed "s/TEAMID123/$TEAM_ID/g" macos-native/ExportOptions.plist > "$EXPORT_OPTIONS"
  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportPath "$EXPORT_DIR" \
    -exportOptionsPlist "$EXPORT_OPTIONS"
  ARTIFACT_KIND="developer-id"
else
  echo "Building explicitly ad-hoc local beta archive for version $VERSION"
  xcodebuild archive \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -archivePath "$ARCHIVE" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY=- \
    CODE_SIGNING_ALLOWED=YES \
    CODE_SIGNING_REQUIRED=YES \
    CODE_SIGN_ENTITLEMENTS=
  mkdir -p "$EXPORT_DIR"
  cp -R "$ARCHIVE/Products/Applications/Tsurfing.app" "$APP"
  ARTIFACT_KIND="ad-hoc-local-beta"
fi

if [[ ! -d "$APP" ]]; then
  echo "Expected macOS application bundle was not produced at $APP." >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP"
codesign --display --verbose=4 "$APP" >/dev/null

if ! command -v create-dmg >/dev/null 2>&1; then
  echo "create-dmg is required to package the verified application." >&2
  exit 1
fi

create-dmg \
  --volname "Tsurfing" \
  --window-pos 200 120 \
  --window-size 600 400 \
  --icon Tsurfing.app 200 190 \
  --app-drop-link 400 185 \
  "$DMG" \
  "$EXPORT_DIR/"

if [[ ! -f "$DMG" ]]; then
  echo "create-dmg returned without producing $DMG." >&2
  exit 1
fi
hdiutil verify "$DMG"

if [[ -n "$NOTARY_PROFILE" ]]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose "$APP"
  NOTARIZATION="complete"
else
  NOTARIZATION="not-requested"
fi

shasum -a 256 "$DMG" > "$DMG.sha256"
shasum -a 256 --check "$DMG.sha256"
printf 'commit=%s\nartifact_kind=%s\nnotarization=%s\n' \
  "$(git rev-parse HEAD)" "$ARTIFACT_KIND" "$NOTARIZATION" > "$DMG.provenance.txt"

echo "MACOS_PACKAGE=PASS artifact=$DMG kind=$ARTIFACT_KIND notarization=$NOTARIZATION"
