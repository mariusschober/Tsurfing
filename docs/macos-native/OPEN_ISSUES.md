> **HISTORICAL FEATURE-BRANCH SNAPSHOT.** Counts, SHAs, and completion claims
> below do not describe the current beta candidate. Current limitations belong
> in `docs/BETA_READINESS.md` only after hosted evidence exists.

# Open Issues — macOS Execution Companion

**Branch:** `feature/macos-execution-companion` @ `a8e3526` (14 ahead, `000cc7d` hardened) + `2fb195c..a8e3526` final hardening (GoalStore sync, sound dedup, force-unwrap). **135 tests green**, `xcodebuild analyze` clean, Debug/Release build OK. No UI pixels changed since `146538d`.

**Legend:** P0 blocker for Developer ID notarization, P1 high for App Store / Liquid Glass mastery. Deferred per 2026-08-30 approvals: keep ad-hoc `CODE_SIGN_IDENTITY "-"`, leave Sparkle fallback, keep `SUPABASE.xcconfig` placeholders.

### P0 — Fixed in last push (verify)

* **Sync staging for goals** — `Services/GoalStore.swift:32,65,95` now stage `goals/truenorth/amalgam` via `buildStagedLocalTransaction` + `orderLock` (was only `tasks/daily_plans`). **Fixed `2fb195c`.**
* **Sound blocking** — `Services/SoundGateway.swift:52,64,76,86,88,117,118` `Thread.sleep` now on dedicated `audioQueue` `com.mariusschober.goalflow.sound` `qos:.userInitiated`, `NSLock defer`, `AVAudioFormat(!) → guard`, `floatChannelData![0] → ?[0]`, `alarm()` via `audioQueue`. Still 2-loop finite burst, `stopAlarm` no-op (finite). **Fixed `09b6053` + `a8e3526`.**
* **Hold duplication** — `UI/ExecutionPanelView.swift:694` `simultaneousGesture(DragGesture)` + `onLongPressGesture` both fired → **keep long-press only** (`54ec34b`).
* **BuildStaging fatalError** — `Sync/BuildStaging.swift:32,36,38` `fatalError → throw SyncError.validation` + `throws` signature, `SyncTests.swift` 8× `try` (`3888a1e`).
* **Force unwraps** — 16 prod `!` → guarded: `Domain/BreakState.swift:14` `.map`, `Domain/SchedulingBridge.swift:36` `TimeZone ?? .current`, `Services/SupabaseAuthService.swift:38,65,112` `guard let URL`, `Services/KeychainSessionStore.swift:83` `guard let`, `Services/BreakdownService.swift:25` `guard let … throw .invalid`, `Sync/ApplyRemotePage.swift:69` `map`, `UI/ExecutionPanelView.swift:65` `as?`, `114/293` optional, `Providers/CurrentTaskProvider.swift:180` `fatalError → throw` (`eb5d5ac`).
* **Menu bar vibrancy** — `UI/MenuBarController.swift:42` removed `Timer 5s` poll → `DistributedNotification AppleInterfaceThemeChangedNotification` + `os.Logger #if DEBUG`, `SoundGateway` queue (`76ede11`).
* **Capture monitor leak** — `UI/CaptureWindowController.swift:15` `monitor: Any?` stored/removed on `hide/deinit` (`4906c8e`).
* **Project signing** — `project.yml:32` `ENABLE_HARDENED_RUNTIME YES` Release (`000cc7d`, `76ede11`), `CODE_SIGN_ENTITLEMENTS ""` stays empty for ad-hoc (deferred).

### P0 — Deferred per approvals (not blocking local, blocking export)

* **Entitlements not wired:** `project.yml:58,63,67` `CODE_SIGN_ENTITLEMENTS ""` overrides `GoalflowMac.entitlements:1-14` (`app-sandbox network.client calendars keychain-access-groups`). **At export:** `xcodebuild DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_ENTITLEMENTS="GoalflowMac/GoalflowMac.entitlements"` or set in `project.yml` when `TEAMID` known. Verify `codesign -d --entitlements :-`.
* **Sparkle missing:** `project.yml` 0 `packages:`, `Info.plist:20` `SUFeedURL https://app.goalflow.com/appcast.xml` but no `SUPublicEDKey`, `UpdaterService.swift:12` fallback `NSWorkspace.open`. **At export:** `brew install sparkle` → `generate_keys` → `SUPublicEDKey` in `Info.plist` + `packages: Sparkle: url: https://github.com/sparkle-project/Sparkle 2.6.4`.
* **Supabase placeholders:** `SUPABASE.xcconfig` `https://example.supabase.co` + `Info.plist SUPABASE_URL ""` → `isConfigured false` → `local-demo` token. **At export:** `export SUPABASE_URL=… SUPABASE_ANON_KEY=… API_ORIGIN=https://app.goalflow.com` before `xcodebuild archive`.

### P1 — High (polish, no UI change)

* `MenuBarController.swift:8-11` 4× IUO `statusItem!/popover!/viewModel!/taskProvider!` — mitigated by `guard` but still IUO; reverted from optional to keep build (`a8e3526`). Future: `NSStatusItem?` with `guard`.
* `Services/SoundGateway.swift` still `Thread.sleep` on dedicated queue (not main) — `stopAlarm` still no-op; future: reuse single `AVAudioEngine` + `Task.sleep`.
* `UI/BreakCoverWindowController.swift:7` `nonisolated(unsafe) windows` + `deinit {for w in windows {w.orderOut}}` — TSAN bypass; future isolate to `@MainActor`.
* `Services/HotkeyGateway.swift:11` `Carbon RegisterEventHotKey` deprecated; works but `app-sandbox` needs `temporary-exception`; future `KeyboardShortcuts` SPM.
* `GoalStore` staging now added but `SyncMeta` `RECORD_LEVEL_STORES` parity with web `services/syncProtocol.ts` needs audit for `amalgam` String vs record.
* `Assets.xcassets/AppIcon.appiconset` only 512@1x/@2x (1×1 placeholder) — needs 16/32/64/128/256 for Finder/Dock.

**Next verification (each <100 LOC, isolated):** `xcodegen generate && xcodebuild build Debug/Release && xcodebuild test -enableThreadSanitizer YES -enableAddressSanitizer YES && xcodebuild analyze` + Instruments `Leaks/Energy Log` final trace (deferred per “final gate only”).

**No interference:** No files under `android-native/`, `android/`, `server/`, `services/` touched in this hardening (except `SyncEngine` parity read-only). `docs/macos-native/` is additive.
