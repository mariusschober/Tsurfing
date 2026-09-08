# Original Goal — macOS Execution Companion (Tahoe Liquid Glass)

**Branch:** `feature/macos-execution-companion` off `f93684ac50562c03c99328d98e57eb67f862eb3b` (origin/goalflow-production 2026-08-30). Isolated under `macos-native/` via `xcodegen generate --spec macos-native/project.yml --project macos-native → macos-native/GoalflowMac.xcodeproj`.

**App identity:** `LSUIElement YES` (`Info.plist:16`) + `NSApp.setActivationPolicy(.accessory)` (`AppDelegate.swift:16`) + `NSStatusItem.variableLength` (`MenuBarController.swift:18`) + `NSPopover.transient`. `MACOSX_DEPLOYMENT_TARGET 15.0` `ARCHS_STANDARD` `CODE_SIGN_IDENTITY "-"` `MARKETING_VERSION 1.0.1` `CURRENT_PROJECT_VERSION 2`. Tests: `xcodebuild test -destination platform=macOS` 135 tests (`GoalflowMacTests/SyncTests 29`, `HardeningTests 8` etc) must stay green. Menu bar Liquid Glass bug now fixed (black-on-black Tahoe vibrantDark/Light + isTemplate + attributedTitle).

**Objective for hardening (this repo, read-only scope unless final phase):**
> Strengthen the entire `macos-native/` codebase only — no new features, no UI/UX changes — to absolute mastery, excellence, and perfect Apple Liquid Glass design code quality (not visual redesign). That means: correctness, efficiency, energy, memory, concurrency, persistence, sync, security, accessibility, and platform idioms at Apple HIG / Liquid Glass engineering standard (transparent, performant, battery-light, correct effectiveAppearance/vibrant handling) without changing what the user sees.

**Scope — audit everything (read-only unless final):**
`macos-native/GoalflowMac/App/AppDelegate.swift MenuBarController.swift CaptureWindowController.swift BreakCoverWindowController.swift`
`Domain/*` (GoalflowTask.swift ExecutionState.swift BreakState.swift CaptureParser.swift SchedulingBridge.swift)
`Services/*` (Clock.swift MonotonicClock FocusSessionStore.swift BreakTimer.swift ExecutionTimer.swift HotkeyGateway.swift SoundGateway.swift DailyPlanStore.swift GoalStore.swift AmalgamStore.swift SupabaseAuthService.swift KeychainSessionStore.swift UpdaterService.swift LoginItemService.swift)
`Sync/*` (StableJson.swift SyncMeta.swift MetaStore.swift BuildStaging.swift ApplyPushResults.swift ApplyRemotePage.swift SyncEngine.swift SyncTransport.swift StoreBridge.swift DeviceIdStore.swift)
`Providers/*` `UI/*` `Resources/Info.plist GoalflowMac.entitlements PrivacyInfo.xcprivacy SUPABASE.xcconfig project.yml scripts/package-dmg.sh GoalflowMacTests/*`

**Invariants to preserve:** `compareQueueCandidates` parity `status=completed|broken_down` no resurrection `schedule-first` `plannedOrder` `getPlanningGate` precedence `stableJson .sortedKeys` `cursor` monotonic `buildStagedLocalTransaction` `readyOutbox 50` `FileFocusSessionStore atomic+WAL` `Carbon RegisterEventHotKey kVK_ANSI_G` `ScreenCaptureKit` fallback.

**Out of scope:** Any new user-facing feature, any visual/UI/UX tweak (keep `ExecutionPanelView` `BreakOverlayView` `CaptureOverlayView` pixels identical), any change to `server/` `supabase/migrations/*` `android-native/` `services/syncProtocol.ts` `services/cloudSync.ts`.

**What excellence means (no visual redesign):**
Find & fix latent bugs, races, leaks, timer drift, `NSLock`/`MainActor`, Combine cancellables, `FileManager` atomicity, Keychain `SecItem` edge cases, `ASWebAuthenticationSession` PKCE, `EKEventStore`, `SCShareableContent`, `SMAppService`, Sparkle fallback, `NSStatusBarButton` Liquid Glass vibrancy. Efficiency: `mach_continuous_time` vs `CACurrentMediaTime`, 50 Hz tick cost, `stableJson` sorting, `sync.json` WAL, haptics/sound, power (`NSWorkspace` sleep/wake), memory (popover transient retain cycles). Correct Apple idioms: `LSUIElement` `effectiveAppearance` handling, `vibrantDark/Light`, `isTemplate`, `accessibilityLabel/Identifier`, `PrivacyInfo CA92.1/C617.1/35F9.1`, entitlements `app-sandbox network.client personal-information.calendars`. Static analysis & Instruments: `xcodebuild analyze`, Thread Sanitizer, Address Sanitizer, leaks, Energy Log, no warnings. Keep 135 tests green; add regression tests only for bugs found.

**Spec snapshot:** `GOALFLOW_MACOS_MUSE_CONTEXT.md` (Tahoe target, Liquid Glass) — referenced at Session A, hash `f93684a`, not committed (external). This `ORIGINAL_GOAL.md` is the vendored summary.

**Deployment snapshot (Session H):** Tahoe SDK 26.5, `LSUIElement` + `NSStatusItem.variableLength` + `NSPopover.transient` + `ScreenCaptureKit` + `EKEventStore` + `SMAppService` + `Sparkle fallback` + `NSStatusBarButton` vibrancy verified.
