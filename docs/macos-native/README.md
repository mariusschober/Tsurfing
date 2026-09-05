# macOS Execution Companion — Isolated Docs

**Scope:** All macOS-native work lives under `macos-native/` (`GoalflowMac/` + `GoalflowMacTests/`). This folder `docs/macos-native/` is the **only** place for macOS planning docs. It does **not** affect `android-native/`, `android/`, `server/`, `services/`, `supabase/` or web CI.

**Isolation rule:** No changes under `android-native/`, `android/`, `server/`, `services/` without explicit sync review. No direct commits to `goalflow-production` — all work on `feature/macos-execution-companion` then deliberate merge.

**Entry points:**
* **Original goal:** `ORIGINAL_GOAL.md` — verbatim Tahoe Liquid Glass brief (branch `feature/macos-execution-companion` off `f93684a`, `LSUIElement` + `NSStatusItem.variableLength` + `NSPopover.transient`, `MACOSX_DEPLOYMENT_TARGET 15.0`, 135 tests)
* **Master plan:** `../MACOS_EXECUTION_COMPANION_PLAN.md` (690 lines, Sessions A-H) and `../MACOS_EXECUTION_COMPANION_HANDOFF.md` (362 lines) — kept at `docs/` root for traceability, will migrate here after merge
* **Current status & next steps:** `NEXT_STEPS.md` (priorities)
* **Known issues:** `OPEN_ISSUES.md` (P0/P1, deferred per ad-hoc/fallback decisions)
* **Starter prompt:** `STARTER_PROMPT.md` — copy-paste to continue final phase
* **Accounts & keys:** `../ACCOUNTS_AND_KEYS.md` (on `goalflow-production`, not duplicated here) + `NEXT_STEPS.md` § Accounts

**Quick start (local):**
```bash
git checkout feature/macos-execution-companion
xcodegen generate --spec macos-native/project.yml --project macos-native
xcodebuild -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -configuration Debug -destination platform=macOS build
xcodebuild test -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -destination platform=macOS  # 135 tests
# ad-hoc: CODE_SIGN_IDENTITY="-" DEVELOPMENT_TEAM="" (keep for local)
# archive: export SUPABASE_URL=... SUPABASE_ANON_KEY=... && ./scripts/package-dmg.sh 1.0.1 TEAMID goalflow-notary
```

**CI:** `.github/workflows/ci.yml` has no macOS job yet — `feature/macos-execution-companion` push does not trigger Android/web gates. Future `macos` job will run `xcodegen` + `xcodebuild test -enableThreadSanitizer -enableAddressSanitizer`.

**Do not:** commit real `SUPABASE_URL`/`ANON_KEY` or real `TEAMID` — placeholders in `macos-native/SUPABASE.xcconfig` (`https://example.supabase.co`) and `macos-native/ExportOptions.plist` (`TEAMID123`) stay.

**Merge plan:** Final `feature/macos-execution-companion` → `goalflow-production` via `--no-ff` after QA, then move `docs/MACOS_*` stubs to this folder with redirect.
