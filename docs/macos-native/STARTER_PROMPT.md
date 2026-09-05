> **HISTORICAL PROMPT — DO NOT EXECUTE.** It targets the divergent macOS
> feature branch and predates the selective transplant. Use
> `docs/reconciliation/BETA_PROVENANCE.md` and the current beta branch.

# Starter Prompt — Continue macOS Execution Companion → Production

Copy-paste to continue final phase (Tahoe 26, Liquid Glass, no visual redesign):

```
Continue Goalflow macOS Execution Companion → production (Tahoe 26, Liquid Glass).

Branch: origin/feature/macos-execution-companion @ a8e3526 (14 ahead, xcodegen → GoalflowMac.xcodeproj, 135 tests, hardened Release YES). Working tree: feature/macos-execution-companion ahead 14 (000cc7d..a8e3526).

Isolated code (no web/android/telegram touch):
macos-native/GoalflowMac/{App/AppDelegate.swift:16 (accessory) + GoalflowMacApp.swift, Domain/* (GoalflowTask.swift ExecutionState.swift BreakState.swift CaptureParser.swift SchedulingBridge.swift), Services/* (Clock.swift ExecutionTimer.swift FocusSessionStore.swift BreakTimer.swift HotkeyGateway.swift SoundGateway.swift:audioQueue DailyPlanStore.swift GoalStore.swift:goals/truenorth/amalgam staged SupabaseAuthService.swift KeychainSessionStore.swift UpdaterService.swift LoginItemService.swift TTSGateway.swift), Sync/* (StableJson.swift SyncMeta.swift MetaStore.swift BuildStaging.swift:throws ApplyPushResults.swift ApplyRemotePage.swift SyncEngine.swift:SyncGate StoreBridge.swift DeviceIdStore.swift), Providers/*, UI/MenuBarController.swift:18 (variableLength, vibrantDark/Light, isTemplate, #if DEBUG Logger) + NSPopover.transient, CaptureWindowController.swift:monitor BreakCoverWindowController.swift:screenSaver, Resources/Info.plist:16 LSUIElement + PrivacyInfo.xcprivacy CA92.1/C617.1/35F9.1 + SUPABASE.xcconfig (placeholder) + ExportOptions.plist TEAMID123 + scripts/package-dmg.sh + appcast.xml}
Docs: docs/MACOS_EXECUTION_COMPANION_PLAN.md (690, Sessions A-H) + docs/MACOS_EXECUTION_COMPANION_HANDOFF.md (362) + docs/macos-native/README.md + ORIGINAL_GOAL.md + OPEN_ISSUES.md + NEXT_STEPS.md (this folder)
Invariants to preserve: schedule-first, compareQueueCandidates parity (groupRank 0/1/2 → plannedOrder → scheduledTime → createdAt → id), status=completed|broken_down no resurrection, plannedOrder tail, getPlanningGate precedence, stableJson .sortedKeys cursor monotonic, buildStagedLocalTransaction readyOutbox 50, FileFocusSessionStore atomic+WAL, Carbon RegisterEventHotKey kVK_ANSI_G, ScreenCaptureKit fallback, menu bar vibrantDark/Light + isTemplate + attributedTitle.

Out of scope: server/supabase/migrations/*, android-native/, services/syncProtocol.ts, services/cloudSync.ts. No new feature, no UI pixels (ExecutionPanelView BreakOverlayView CaptureOverlayView identical).

Accounts for final run (placeholders stay, inject at export per NEXT_STEPS.md): Apple Developer Team ID + Developer ID Application + notarytool keychain profile goalflow-notary (APPLE_ID), Supabase URL/anon (SUPABASE.xcconfig) + service_role (Railway only), Railway API_ORIGIN https://app.goalflow.com, Sparkle EdDSA deferred (fallback NSWorkspace.open).

Verify: xcodegen generate --spec macos-native/project.yml --project macos-native && xcodebuild -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -configuration Debug -destination platform=macOS build && xcodebuild -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -configuration Release -destination platform=macOS build && xcodebuild test -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -destination platform=macOS && xcodebuild analyze
Next: wire entitlements at export (CODE_SIGN_ENTITLEMENTS), stage Goals already done (2fb195c), sound dedicated queue (09b6053), hold long-press only (54ec34b), force-unwrap cleanup (eb5d5ac), Instruments final gate only.
```

**Files to read first:** `docs/macos-native/ORIGINAL_GOAL.md`, `docs/macos-native/NEXT_STEPS.md`, `docs/MACOS_EXECUTION_COMPANION_PLAN.md:1-100`, `macos-native/project.yml:15.0`, `macos-native/GoalflowMac.xcodeproj/project.pbxproj:517` (CODE_SIGN), `macos-native/GoalflowMac/Services/GoalStore.swift:32` (staging), `macos-native/GoalflowMac/UI/MenuBarController.swift:42` (vibrancy).

**Push cleanly:** `git checkout feature/macos-execution-companion && git push origin feature/macos-execution-companion` (fast-forward, no `goalflow-production`/`main`).

**Do not:** commit real `SUPABASE_URL`/`TEAMID`, add `packages:` Sparkle until you have `SUPublicEDKey`, touch `android-native/`/`server/` without sync review.
