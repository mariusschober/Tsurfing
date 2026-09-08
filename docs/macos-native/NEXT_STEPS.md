# Next Steps — Reliable, Performant, Soon (no new features, no UI change)

**Branch:** `feature/macos-execution-companion` `a8e3526` (+ `2fb195c..a8e3526` final hardening) — 14 ahead of `origin/feature/macos-execution-companion`. Push is fast-forward `feature/macos-execution-companion` only, no `goalflow-production`/`main`/`feat/telegram-v1` impact. CI `ci.yml` has no macOS job yet → push is safe.

**Priorities (ordered, each <100 LOC, verifiable via `xcodegen generate && xcodebuild build Debug/Release && xcodebuild test` 135 green):**

1. **Export wiring (when you have Team ID, ~30 min):**
   ```bash
   export SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=eyJ... API_ORIGIN=https://app.goalflow.com
   xcodebuild archive -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -configuration Release -archivePath build/GoalflowMac.xcarchive CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_ENTITLEMENTS="GoalflowMac/GoalflowMac.entitlements"
   ./scripts/package-dmg.sh 1.0.1 "$TEAM_ID" goalflow-notary
   codesign -d --entitlements :- build/Export/GoalflowMac.app | grep -q app-sandbox
   xcrun notarytool submit build/GoalflowMac-1.0.1.dmg --keychain-profile goalflow-notary --wait && xcrun stapler staple build/GoalflowMac-*.dmg && spctl --assess --type open build/Export/GoalflowMac.app
   ```
   Bump `MARKETING_VERSION 1.0.1 → 1.0.2` / `CURRENT_PROJECT_VERSION 2 → 3` when ready.

2. **Host feed (if you enable Sparkle tomorrow):**
   `brew install sparkle` → `generate_keys` → `SUPublicEDKey` in `Info.plist:20` + `packages: Sparkle 2.6.4` in `project.yml` + sign `appcast.xml` enclosure `https://app.goalflow.com/releases/GoalflowMac-1.0.2.dmg` `sparkle:edSignature`.

3. **Instruments final gate (once, Release):**
   `xcodebuild test -enableThreadSanitizer YES -enableAddressSanitizer YES` + Instruments `Leaks`, `Energy Log`, `Time Profiler` (50 Hz hold only while holding, 1 Hz tick, `stableJson` sort, `sync.json` WAL). No warnings.

### Accounts & API keys needed for next final run (you said keep placeholders/ad-hoc/fallback — so only at export):

| Account | Where to register | Key to provide | Env / arg | File (placeholder stays) |
|---|---|---|---|---|
| **Apple Developer** | developer.apple.com enroll $99, Membership → Team ID, Xcode → Manage Certificates → Developer ID Application, `xcrun notarytool store-credentials goalflow-notary --apple-id <apple@id> --team-id <TEAMID> --password <app-specific-password>` | Team ID `ASDF123456` + Apple ID email + app-specific password (2FA) | `TEAM_ID` arg to `package-dmg.sh`, `DEVELOPMENT_TEAM` override | `macos-native/ExportOptions.plist teamID TEAMID123` + `project.yml DEVELOPMENT_TEAM ""` |
| **Supabase** | supabase.com Dashboard → New Project → Settings → API → Project URL + anon public + service_role | `SUPABASE_URL https://<ref>.supabase.co`, `SUPABASE_ANON_KEY eyJ…` (public), `SUPABASE_SERVICE_ROLE_KEY` (server-only, Railway) | `SUPABASE_URL`, `SUPABASE_ANON_KEY` | `macos-native/SUPABASE.xcconfig` (`https://example…`) + `Info.plist SUPABASE_URL` |
| **Railway / API_ORIGIN** | railway.app New Project from GitHub `mariusschober/Goalflow` `goalflow-production`, `railway.json` nixpacks | `API_ORIGIN https://app.goalflow.com` (or `*.up.railway.app`) | `API_ORIGIN`, `VITE_API_ORIGIN`, `APP_ORIGIN` | `SUPABASE.xcconfig API_ORIGIN`, `Info.plist API_ORIGIN` |
| **Sparkle** *(deferred)* | `generate_keys` | EdDSA pub `spds…` → `SUPublicEDKey`, priv `~/.sparkle` | — | `Info.plist SUPublicEDKey` + `appcast.xml` |
| **Keychain/Domain** | no account | — | — | `GoalflowMac.entitlements keychain-access-groups`, `Info.plist goalflow://auth/callback` |

*Not needed for macOS binary:* Turnstile, Resend SMTP, Telegram bot, DeepSeek/OpenAI (server / web only). Full list in `docs/ACCOUNTS_AND_KEYS.md` (on `goalflow-production`).

### 2-week reliable launch path:

* Week 1: export wiring + Goals sync already staged (`2fb195c`) + sound dedicated queue (`09b6053`) + hold dedup (`54ec34b`) + force-unwrap cleanup (`eb5d5ac`) — **done**. Do Instruments trace + bump version.
* Week 2: notarized DMG to `https://app.goalflow.com/appcast.xml`, `spctl` verify, dogfood `SyncEngine` push/pull cursor, then `git merge --no-ff feature/macos-execution-companion` into `goalflow-production`.

**No interference:** No edits under `android-native/`, `android/`, `server/`, `services/` in these docs; `docs/macos-native/` is additive only.
