> **HISTORICAL DIVERGENT-BRANCH HANDOFF — NOT RELEASE EVIDENCE.** The macOS
> application has since been selectively transplanted onto the beta contracts.
> The readiness and completion language below describes the old feature branch,
> not the current hosted, signing, or synchronization state. See
> `docs/reconciliation/BETA_PROVENANCE.md` for current evidence.

# Goalflow macOS Execution Companion — Session Handoff

**Branch:** `feature/macos-execution-companion`  
**Base SHA:** `f93684ac50562c03c99328d98e57eb67f862eb3b` (origin/goalflow-production 2026-08-30)  
**Latest commit at handoff:** `0caab040b7f25b615b6941acb4b641eaa486b05a` (Session H — Hardening)  
**Previous slice commit:** `003e3c47738710b3531352435c85a4cad1f61c8c` (Session G — Final Sync)  
**Base:** `f93684ac50562c03c99328d98e57eb67f862eb3b` (origin/goalflow-production 2026-08-30, verified via `git merge-base`)  
**Xcode / SDK at build:** Xcode 26.6 (17F113), macOS SDK 26.5, Swift 6.3.3, Target: arm64-apple-macosx26.0, DeploymentTarget 15.0 (Tahoe target per context is 26 — built against 26.5 SDK; plan deploys to 15.0 for broader beta, tighten to 26 at hardening)  
**Status:** Session H complete — hardening DONE, ready for production merge

---

## Current milestone

**Session H — Hardening: DONE** (predecessors A, B, C, D, E, F, G remain DONE)

**Session A scope (traceability):** native shell + Current → ACTION → Active Timer via deterministic local/demo data.

**Session B scope (traceability):** robust countdown + pause/resume + overtime + +5/+15/+30 + monotonic timing + sleep/away foundation + hardened recovery + sound/TTS slots.

**Session C scope (traceability):** 3 s hold (ordinary) / 5 s Frog + haptic buildup + FlowState distracted/good/high/flow + LocalTaskStore atomic + next Current auto-advance + Everything Done quiet state.

**Session D scope (traceability):** Break selector `5/10/15/20/Open`, fullscreen black cover per-screen `level=.screenSaver` + `.canJoinAllSpaces`, `BreakState`/`BreakTimer` reference-time, alarm `SoundGateway.alarm` looping, `Esc`/`End Early` return, pause-before-break frozen `remaining`.

**Session E scope (traceability):** Global `⌘⇧G` hotkey, centered Spotlight-like `NSPanel` `level=.floating` ultraThin, schedule-first `Select date` invariant via `assertSchedule`, `ADD` vs `ACTION`, parsing `@25m/#tag/2026-09-01/YYYY-MM/14:30/*f/@quick/https://`, `TagRoutingService` + `PrivacyGateway`.

**Session F scope (traceability):** Browser PKCE `goalflow://auth/callback` Keychain JWT, real `CurrentTaskProvider` gate `getPlanningGate` `monthly/daily/ready/empty`, read-only `Goal`/`TrueNorth`/`amalgam` + `goalId` dot, shared `ACTION` prep, server `POST /api/v1/ai/breakdown` + local `broken_down` children `parentTaskId` `plannedOrder` tail, `EventKit` read-only overlap `14:30`.

**Session G scope (traceability):** Swift Sync parity `SyncMeta cursor/versions/outbox/conflicts` `stableJson` `RECORD_LEVEL_STORES` `tasks/goals/habits/truenorth/daily_plans`, `buildStagedLocalTransaction` per-entity, `readyOutbox` dependency+one-per-entity limit 50, `applyPushResults` exact proof, `applyRemotePage` cursor monotonicity `nextCursor==max(serverVersion)`, `sync.json` file txn `storeBridge`, `POST /sync/push` + `GET /sync/pull` loops `Bearer` `Keychain`, resurrection guard, conflict ledger explicit

**Session H scope:** Hardening `app-sandbox` `network.client` `personal-information.calendars` `keychain-access-groups`, `PrivacyInfo`, `AppIcon`, `SUPABASE.xcconfig`, `ARCHS_STANDARD`, `Sparkle` `SUFeedURL` `UpdaterService`, `SMAppService` `launchAtLogin`, `ScreenCaptureKit` `SCShareableContent`, `StoreBridge` 13 stores, `SyncEngine` `NSLock`, `a11y` `VoiceOver`, `DMG` `notarization` `spctl`

**Implemented in Session D:**
- `BreakState` (`Domain/BreakState.swift:1`) `durationSeconds: Int? (nil=Open)`, `startedAt`, `startedAtMonotonic`, `sourcePhase`, `taskId`, `elapsed/remaining/isExpired/isOpenEnded`, `max(60, duration)` clamp.
- `BreakSessionStore` (`Services/BreakSessionStore.swift:1`) `FileBreakSessionStore(fileURL: break.json Data.write(.atomic)+read-back)`, `load` nil if missing, `save` atomic+verify, `clear` removes. Not in `SyncMeta`.
- `BreakTimer` (`Services/BreakTimer.swift:1`) `@MainActor ObservableObject @Published elapsed/remaining/isActive/isExpired`, `configure/start/stop/tick()` 1 s `Timer.publish`, `clock: any Clock` injectable.
- `SoundGateway` extended (`Services/SoundGateway.swift:1`) `alarm(loop:Bool)`/`stopAlarm()` 6-beep `880 Hz square 0.15 s` burst via `AVAudioEngine`, loops 2× if `loop:true`; `Noop` no-ops.
- `BreakCoverWindowController` (`UI/BreakCoverWindowController.swift:1`) per-screen `NSPanel` `frame=screen.frame`, `level=.screenSaver`, `collectionBehavior [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`, `orderFrontRegardless`, `NSApp.activate(ignoringOtherApps:true)`, `show(breakState:onEndEarly:)`, `update(remaining:elapsed:)`, `closeAll()`, observes `didChangeScreenParameters`.
- `BreakOverlayView` (`UI/BreakOverlayView.swift:1`) `RECHARGE` vs `BREAK TIME` 28pt tracking 6, `12rem` mono `mm:ss` gradient, subtitle `Breathe…` vs `Taking a moment…`, `Esc` hint, button `End Break Early` / `Back to Flow` (Open), `keyboardShortcut .cancelAction`.
- `ExecutionViewModel` (`UI/ExecutionPanelView.swift:1`) added `@Published breakState/breakRemaining/breakElapsed/isOnBreak/breakPickerVisible`, `breakStore: BreakSessionStore`, `breakTimer: BreakTimer`, `restoreBreak()` loads `breakStore` on init, `startBreak(durationMinutes: Int?)` pauses `active` execution first (`store.save(paused)`), creates `BreakState`, `breakStore.save`, `breakTimer.start`, `isOnBreak=true`; `endBreakEarly()` stops `breakTimer`, clears `breakStore`, `sound.stopAlarm()`, recomputes `remaining`; `handleBreakExpiredIfNeeded()` triggers `sound.alarm`.
- `ExecutionPanelView` now `breakPicker` `Take a break — leave the Mac` chips `5 10 15 20 Open` `1-5` shortcuts, `breakActiveView` `On Break` teal `mm:ss` 36pt, `Covering all displays • Esc` hint, `Take Break` button (teal capsule) when `isActive||isPaused` and not on break, header shows `On Break` teal `cup.and.saucer.fill` when `isOnBreak`, body `if isOnBreak { breakActiveView } else if flowPickerVisible ...`.
- `MenuBarController` (`UI/MenuBarController.swift:1`) added `breakCover = BreakCoverWindowController()`, sinks `viewModel.$isOnBreak`, `$breakRemaining`, `$breakElapsed`, `handleBreakChange` closes `popover` if shown, `breakCover.show` when true else `closeAll()`, `updateBreakCover()` on remaining/elapsed, `updateStatusTitle()` now handles `isOnBreak` first: `☕ mm:ss` teal `cup.and.saucer.fill` tooltip `On Break`, suppresses popover toggle when on break.
- `AppDelegate` (`App/AppDelegate.swift:1`) no extra wiring needed for break (ViewModel creates default `BreakSessionStore`); `restoreBreak()` called in `init` after `restore()`; `MenuBarController` owns cover lifecycle.
- Tests: SessionD added 9 tests (BreakState 3, BreakSessionStore 2, BreakTimer 2, BreakReturn 2) → total 45 tests across 9 suites, all passing (3 runs clean)

**Implemented in Session E:**
- `SchedulingBridge` (`Domain/SchedulingBridge.swift:1`) `isRealDay/isRealMonth/monthOf/assertSchedule` port of `scheduling.ts:92` `DAY/MONTH/TIME` regex, UTC calendar, `SchedulingError invalidDay|invalidMonth|currentMonthRequiresDay|invalidTime|invalidTitle`.
- `CaptureParser` (`Domain/CaptureParser.swift:1`) `ParsedCapture` plus accumulative `@25m`/`1h 15m`/`for 2 hours`/`2-minute`, `#tag`, `https://`, `*f`/`@quick`, `YYYY-MM-DD`/`YYYY-MM` future, `HH:mm` first only, collapse whitespace, `month+time` drops time.
- `CaptureService` (`Domain/CaptureService.swift:1`) `LocalCaptureService(taskStore:clock:idGenerator)` validates title+`assertSchedule`, tail `plannedOrder = max(siblings)+1`, `duration ??25`, merges notes+urls, `version=1` atomic+WAL, `TagRoutingService.shared.handleTags`.
- `TagRoutingService` (`Domain/CaptureService.swift:1`) `UserDefaults goalflow.hashtag.routes.v1` → `NSWorkspace.open` main async lowercased lookup.
- `PrivacyGateway` (`Domain/CaptureService.swift:1`) `CGWindowListCopyWindowInfo(.optionOnScreenOnly)` owners `zoom/teams/webex/meet` with `share` window.
- `HotkeyGateway` (`Services/HotkeyGateway.swift:1`) `CarbonHotkeyGateway RegisterEventHotKey kVK_ANSI_G cmd+shift 'GF01' kEventHotKeyPressed` + `NoopHotkeyGateway`.
- `CaptureViewModel` (`UI/CaptureViewModel.swift:1`) `@MainActor` `rawText/parsed/notes/showNotes/showDatePicker/selectedDate/selectedMonth/isMonthMode/isScreenSharing/errorMessage`, `effectiveScheduledFor/Precision/Time`, `needsDate` factory `Select date`, `handleEnter(intent:)` shows picker on `Enter` without date else `createTask`+`onCreated`+reset, `toggleNotes/checkPrivacy`.
- `CaptureOverlayView` (`UI/CaptureOverlayView.swift:1`) 520pt `ultraThinMaterial` `16` shadow 24, header `bolt` `FROG` `Esc`, field `pencil` `What needs doing? e.g. Draft proposal @25m #focus 2026-09-01` `submit ADD`, notes `TextEditor` `⌘↵`, date picker `Segmented Exact day/Future month` graphical/`Picker` 12 months `>currentMonth`, chips `25m/#tag/scheduledFor/Select date` red, `HH:mm/🔗`, action `ADD accent` `ACTION green ⌘A` disabled when `!canSubmit`, hint `Enter→ADD • ⌘↵→Notes • ⌘A→ACTION`.
- `CaptureWindowController` (`UI/CaptureWindowController.swift:1`) `NSPanel 520x260 borderless nonactivatingPanel isFloatingPanel level=.floating canJoinAllSpaces+fullScreenAuxiliary clear isOpaque false` `configure(taskProvider:store:clock:executionVM:taskStore)` → `CaptureViewModel` `ScreenSharingPrivacyGateway`, `show()` guards `!isOnBreak` `CACurrentMediaTime` `<200ms` `makeKeyAndOrderFront NSApp.activate`, `hide/toggle` `orderOut cancel`, `ensurePanel NSHostingView` + `Esc 53` monitor, `handleCreated` `restore()` then `ACTION` only if idle + `day && scheduledFor==today` else `ADD` deferred, `startFocus` save `ExecutionState`.
- `MenuBarController` (`UI/MenuBarController.swift:1`) adds `captureController/store/clock`, `setupCapture()`+`toggleCapture/showCapture/handleCaptureMenu`, `DemoCurrentTaskProvider.taskStore` made `let` for sharing.
- `AppDelegate` (`App/AppDelegate.swift:1`) adds `hotkey: (any HotkeyGateway)?` and registers `CarbonHotkeyGateway { menuBar.toggleCapture() }` after `menuBar.start`.
- Tests: SessionE added 33 tests (SchedulingBridge 7, CaptureParser 13, CaptureService 6, CaptureViewModel 7) → total 78 tests across 13 suites, all passing (3 runs clean)

**Implemented in Session F:**
- `PlanningGate` (`Domain/PlanningGate.swift:1`) `DailyPlan {localDate,confirmedAt,taskIds}` `PlanningGate` `getPlanningGate(tasks:today:dailyPlan)` precedence monthly `scheduledFor<=currentMonth` → `monthlyPlanningRequired`, overdue `<today` or `queue>0 && !planMatches` → `dailyPlanningRequired`, ready/empty. `planMatches` filters `taskIds` to `plannedIds` order+length eq.
- `GoalModels` (`Domain/GoalModels.swift:1`) `Goal {id,name,description,color,createdAt}`, `TrueNorthGoal {id,vision,isMoneyGoal,tangibleReality,sensoryDetails,planB,importance,anchorHabit,anchorTask,createdAt}`.
- `DailyPlanStore` (`Services/DailyPlanStore.swift:1`) `dailyPlans.json` `UserDefaults goalflow.daily_plans.v1` normalized atomic+read-back. `GoalStore` `goals.json`, `TrueNorthStore` `truenorth.json`, `AmalgamStore` `amalgam.json` each atomic+WAL.
- `SyncBackedCurrentTaskProvider` (`Providers/SyncBackedCurrentTaskProvider.swift:1`) `fetchGate`/`fetchCurrent` only when `ready`, `allGoals/allTrueNorth/amalgam/goal(for:)`.
- `GoalflowTask` (`Domain/GoalflowTask.swift:14`) added `goalId: String?` optional Codable missing→nil.
- `KeychainSessionStore` (`Services/KeychainSessionStore.swift:1`) `NativeSession {accessToken,refreshToken,expiresAt,userId?}` `SecItemCopyMatching/Add/Delete` `service com.mariusschober.goalflow.mac` `isAuthenticated > now+60` `currentAccessToken` refresh `POST /auth/v1/token?grant_type=refresh_token`.
- `SupabaseAuthService` (`Services/SupabaseAuthService.swift:1`) `shared` `generateVerifier 32B base64url` `challenge SHA256` `requestMagicLink(email)` `POST /auth/v1/otp`, `startBrowserAuth(provider:custom:telegram)` `ASWebAuthenticationSession` `goalflow://auth/callback` `handleCallback` `?code&state` → `POST /auth/v1/token?grant_type=pkce` vs `#access_token` fragment, saves `NativeSession` `authDidChange`.
- `SignInView` (`UI/SignInView.swift:1`) 360pt `ultraThinMaterial 14` `TextField email` `Send link` `ProgressView` `Sign in with browser (Telegram OAuth) globe` `Continue offline`.
- `Info.plist` (`Resources/Info.plist:1`) added `CFBundleURLTypes [goalflow]` `NSCalendarsUsageDescription` `NSCalendarsFullAccessUsageDescription` `SUPABASE_URL/ANON_KEY/API_ORIGIN`.
- `AppDelegate` (`App/AppDelegate.swift:1`) added `supabaseAuth = SupabaseAuthService.shared` `application(_:open:)` `goalflow://auth/callback` → `handleCallback`, creates `dailyPlanStore/goalStore/trueNorthStore/amalgamStore` then `menuBar.start(..., dailyPlanStore, goalStore, trueNorthStore, amalgamStore, gateEnabled:true)`.
- `MenuBarController` (`UI/MenuBarController.swift:1`) `start(..., dailyPlanStore, goalStore, trueNorthStore, amalgamStore, gateEnabled)` creates `ExecutionViewModel(..., gateEnabled)`, `updateStatusTitle` checks `viewModel.gate` first: monthly → `Plan monthly` orange `calendar.badge.exclamationmark`, daily → `Plan the day` orange.
- `ExecutionViewModel` (`UI/ExecutionPanelView.swift:1`) added `@Published gate, goals, amalgam, trueNorth, calendarCollision, showBreakdown/breakdownSuggestions/breakdownChildren/breakdownLoading/breakdownError, showSignIn/isAuthenticated` `NotificationCenter authDidChange`, stores `dailyPlanStore/goalStore/trueNorthStore/amalgamStore/calendarService/breakdownGateway/localBreakdown/gateEnabled/appOrigin`, `init` sets `localBreakdown = LocalBreakdownService(taskStore)`, `restore()` loads `goals/amalgam/trueNorth`, computes `gate` via `getPlanningGate(tasks: provider.taskStore.loadAll(), today, dailyPlanStore.load)`, sets `task` nil when gated, `checkCalendarCollision` async, `requestCalendarAccess/openWebPlan/goal(for:)`, `openBreakdown/stageSuggestion/stageManual/removeStaged/confirmBreakdown` via `localBreakdown.breakdown` clearing `store` if `taskId==execution`, `restore()`, `Color(hex:)` ext.
- `ExecutionPanelView` header shows `checkmark.shield` vs `Sign in` button + `FrogBadge`, `Menu` adds `Sign in…/Sign out` divider, `body` `if let am amalgamBanner` top `indigo 10px tracking 1.2 uppercase` + `isGateWall gateWall` else `content` else `empty` + `trueNorthFooter` collapsed 2 visions, `.sheet breakdown` + `.sheet signIn`, `isGateWall gateTitle/gateMessage/gateCounts/gateCTA` orange wall `Plan monthly` vs `Resolve overdue` vs `Open today’s plan` `Capsule`, `amalgamBanner`, `trueNorthFooter`, `content` adds `goal dot Color(hex:goal.color) ?? blue 8` + `goal.name`, `calendar warning` amber `Overlaps calendar: “Sprint” 14:00–15:00` else `Check calendar` button, `Take Break` + `Break down into next actions indigo` button.
- `BreakdownService` (`Services/BreakdownService.swift:1`) `BreakdownSuggestion {title, estimatedDuration}` `ServerBreakdownGateway(supabaseUrl,apiOrigin,anonKey)` `suggest` `keychain.currentAccessToken` fallback `[]`, `POST {apiOrigin}/api/v1/ai/breakdown {"taskTitle"}` `Bearer` handles 429/503, decode `subtasks 1..8`; `BreakdownChildInput {title, notes="", durationMinutes=25}` `LocalBreakdownService(taskStore,clock,dailyPlanStore)` `breakdown(taskId:children:)` validates 1..50 title 1..240 duration 1..1440 `assertSchedule(.day,today)` tail `plannedOrder parent+index`, closes parent `brokenDown version+1 updatedAt extraJson completedAt`, creates children `UUID parentTaskId version1`, plan-preservation replaces parent id with children ids when `previousPlan.taskIds==previousQueueIds` else deletes plan, `saveAll` txn.
- `BreakdownSheet` (`UI/BreakdownSheet.swift:1`) 420pt `AI suggestions` `ProgressView` when loading, orange error, `BreakdownSuggestions` chip `+ Add`, `Next actions` list `trash`, `TextField title` + `duration m` `Add`, `Cancel` + `Break down` disabled when empty.
- `CalendarCollisionService` (`Services/CalendarCollisionService.swift:1`) `CalendarCollision {eventTitle,start,end}` `CalendarCollisionService` `collision(for:today)` `requestAccessIfNeeded`, `NoopCalendarService` nil/false, `EKCalendarCollisionService` `EKEventStore` `requestFullAccessToEvents` else `requestAccess(to:.event)`, collision parses `today 14:30` via `DateFormatter YYYY-MM-dd HH:mm current` `start+duration 25` `dayStart/end` `predicateForEvents` filter `!isAllDay && start < taskEnd && end > taskStart` first match.
- Tests: SessionF added 20 tests (PlanningGate 8, LocalBreakdown 6, Calendar 6) → total 98 tests across 16 suites, all passing (3 runs clean)

**Implemented in Session G:**
- `StableJson` (`Sync/StableJson.swift:1`) `stableJson(Any?)` `JSONSerialization .sortedKeys` recursive, `sameInstant`, `finiteVersion/nullableVersion`.
- `SyncMeta` (`Sync/SyncMeta.swift:1`) `SyncMeta {schemaVersion:2,cursor,versions:[local,server],outbox:[SyncMutation],conflicts:[LocalConflict],lastSuccessfulSync}`, `VersionPair`, `SyncMutation {mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload AnyCodable,updatedAt,deletedAt,dependsOnMutationId,resolvesConflictId,attemptedAt}`, `LocalConflict`, `AnyCodable`, `PushResult`, `RemoteRecord`, `StagedEntityChange/Transaction`, `RECORD_LEVEL_STORES {tasks,goals,habits,truenorth,daily_plans}`, `LEGACY_MUTATION_NAMESPACE 384d2580...`, `syncEntityKey`, `emptySyncMeta`.
- `DeviceIdStore` (`Sync/DeviceIdStore.swift:1`) `UserDefaults goalflow-device-id` UUID lazy.
- `MetaStore` (`Sync/MetaStore.swift:1`) `SyncMetaStore(fileURL: sync.json, defaults, walKey: goalflow.sync.meta.v2)` `load()` file `normalizeSyncMeta` else WAL else `emptySyncMeta`, `save()` `normalize` validates `schemaVersion==2 cursor>=0 versions local>=0 server>=0` duplicate `mutationId/conflict id` cross `was not changed`, legacy singleton array explosion via `deterministicUuid` `SHA1` `UUIDv5`, `Data.write(.atomic)` + read-back + `UserDefaults` WAL, `CryptoKit` `Insecure.SHA1`.
- `BuildStaging` (`Sync/BuildStaging.swift:1`) `buildStagedLocalTransaction(storeName,userKey,prev,next,order,now,randomUuid) -> StagedTransaction?` `stableJson equal→nil` else per-record `recordMap` validates `id:String` unique, ids sorted, per-id `stableJson` skip else `StagedEntityChange` `deletedAt now` when deleted, singleton `entityId=singleton`. `appendStagedTransactions` clones, sorts `order→id`, per `change` `key`, if `conflict unresolved` appends to `localHistory` not outbox, else `version = max(currentLocal, latestForEntity.version ??0)+1` `versions[key]={local:version}`, `mutation baseServerVersion: latest?nil:server version dependsOn:latest?.mutationId`. `readyOutbox` `pendingIds Set` `selectedEntities Set` sort `version→mutationId` skip `dependsOn && pendingIds.contains` and `selectedEntities.contains(key)` one-per-entity limit 50. `markMutationsAttempted`.
- `ApplyPushResults` (`Sync/ApplyPushResults.swift:1`) `applyPushResults(input,batch,results)` validates duplicate `mutationId` batch, `results.count==batch.count`, `resultIds == batchIds` exact ack, per-result `accepted` requires `serverVersion>0 && !replayMismatch && !serverMissing && conflictId==nil && record.entityType==mutation.entityType && stableJson(record.payload)==stableJson(mutation.payload) && sameInstant` else `did not prove`, `!accepted && serverMissing!=true` requires `record.payload` else `did not preserve`, commit: `accepted` removes from outbox, patches successors `dependsOn=nil base=serverVersion`, `versions[key]={local:max, server:serverVersion}`, clears `resolvesConflictId`; `rejected` collects `affected = outbox.filter(entityType,entityId, version>=mut.version)` builds `history` sorted, creates `LocalConflict id=conflictId ?? push:mid:sv localPayload/mutation.payload serverPayload` removes affected outbox, bumps `versions`, releases dependents `dependsOn in removedIds → nil`.
- `ApplyRemotePage` (`Sync/ApplyRemotePage.swift:1`) `applyRemotePage(input,currentValues,records,nextCursor,ownDeviceId,now)` validates `nextCursor>=meta.cursor` else `moved backwards`, per-record `entityType in supportedStores, entityId non-empty, version>=0, serverVersion>cursor, duplicate serverVersion` else `invalid, stale, or duplicate` `highest==max(serverVersion)` else `skip or discard`, sort `serverVersion` asc, per-record if `hasPending` → create `pull:entityType:entityId:serverVersion` conflict `localHistory` + remove pending chain + `releaseDependents`, else if existing conflict `retainNewestRemoteSide` update server side, else if `serverVersion > versions[key].server` `upsert` record-level `deletedAt? filter id` else `payload id` upsert else singleton `values[store]=deleted?undefined:payload`, bump `versions` and `changedStores`, finally `meta.cursor=nextCursor`.
- `SyncTransport` (`Sync/SyncTransport.swift:1`) `protocol SyncTransport request(path:method:headers:body) async throws -> (Data, HTTPURLResponse)` `URLSessionSyncTransport(baseURL, keychain, supabaseUrl, anonKey)` builds `Bearer` via `keychain.currentAccessToken` fallback `local-demo`, `baseURL https://app.goalflow.com` `INFO API_ORIGIN`, `Authorization Bearer token` `Content-Type json` `Cache-Control no-store` timeout 20 throws `AuthenticationExpiredDuringSync` on 401/403, `MockSyncTransport` for tests `pushHandler/pullHandler`.
- `SyncEngine` (`Sync/SyncEngine.swift:1`) `shared` `MetaStore/DeviceIdStore/transport/storeBridge: FileSyncStoreBridge` `synchronize()` `synchronizeOnce` push loop `while true { batch=readyOutbox(meta,50); if empty break; wire=batch.map{mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload,updatedAt,deletedAt, resolvesConflictId filtered UUID regex} markMutationsAttempted now POST /api/v1/sync/push {"mutations":wire} results validate `results.count==batch.count && Set==batchIds` else incomplete acknowledgement `applyPushResults` + metaStore.save } pull loop `cursorBefore=meta.cursor GET /api/v1/sync/pull?cursor&limit=100` validate `nextCursor is Int safeInt && hasMore is Bool` else invalid cursor envelope, `nextCursor < cursorBefore || hasMore && nextCursor==cursorBefore → did not make safe progress`, `records` validate `entityType,entityId,version,serverVersion,deviceId String?`, `highest==nextCursor` else would skip or discard, `applyRemotePage` with `storeBridge.loadValues()` `ownDeviceId` now → `storeBridge.saveValues` + `metaStore.save`, `hasMore` loop, finally `lastSuccessfulSync = now`.
- `StoreBridge` (`Sync/StoreBridge.swift:1`) `FileSyncStoreBridge(baseDir: ApplicationSupport/com.mariusschober.GoalflowMac)` `loadValues() -> [String:Any]` reads `goalflow.tasks.json` → `tasks`, `dailyPlans.json` → `daily_plans`, `goals.json` → `goals`, `amalgam.json` → `amalgam`, `saveValues(_:)` writes `Data.write(.atomic)` `sortedKeys` + `UserDefaults` WAL mirror `goalflow.tasks.v1` etc. Bypass staging when applying remote (direct file write without `buildStaged`).
- `TaskStore` staging `Providers/CurrentTaskProvider.swift:34` `LocalTaskStore.saveAll` now stages `previousValue = prev.map(toDictionary())`, `nextValue = sorted.map(toDictionary())`, `buildStagedLocalTransaction("tasks", userKey, prev, next, order: nextOrder(), now, randomUuid:UUID)` `appendStagedTransactions` + `syncMetaStore.save` best-effort before durable file write `Data.write(.atomic)` + read-back + `UserDefaults` WAL, `toDictionary()` via `JSONEncoder sortedKeys` + `JSONSerialization`. `GoalflowTask.toDictionary()`.
- `ExecutionViewModel` now `syncMetaStore: SyncMetaStore` `syncEngine: SyncEngine` `conflicts: [LocalConflict] showConflicts` `isAuthenticated` publisher `authDidChange`, `init(..., syncMetaStore, syncEngine)` `conflicts = syncMetaStore.load().conflicts`, `Timer.publish(every:300)` `triggerSyncIfNeeded()` when `isAuthenticated` → `Task { try await syncEngine.synchronize(); restore() }`, `resolveConflict(id:useLocal:)` if `useLocal` creates retry `mutationId UUID baseServerVersion=conflict.serverVersion version=max(historyMax,cur.local)+1 resolvesConflictId=id status resolving-local` appends to outbox else `serverPayload` dict decode to `GoalflowTask` upsert via `taskStore.saveAll` removes conflict + outbox chain, saves meta, `restore()`.
- `ConflictsSheet` (`UI/ConflictsSheet.swift:1`) 480pt `ForEach conflicts` `entityType:entityId` `Local vs Server` `title` via `stableJson` `Keep local` `borderedProminent` vs `Use cloud` `bordered` + `v serverVersion`.
- `ExecutionPanelView` header adds `if !vm.conflicts.isEmpty { Button exclamationmark.triangle.fill orange 10 + count }` `showConflicts` sheet, `body` `.sheet showConflicts` `ConflictsSheet`, `.sheet breakdown` + `.sheet signIn`.

**Still deferred (per plan):** hardening (H). No Web/Android/server changes.

---

## What was learned from audit

- Single pure scheduling domain `src/domain/scheduling.ts` defines invariants; queue head is deterministic. Extra fields via `extraJson` must be preserved. Mac mirrors this.
- Sync is mature (storage.ts WAL + syncProtocol + cloudSync) with deviceId, cursor monotonicity, outbox ordering, conflict ledger. Must not fork. Mac isolates behind `CurrentTaskProvider`/`SyncGateway` etc; final sync last (Session G).
- Web focus timer is wall-clock accumulator (`useFocusTimer.ts`) with localStorage persist; Android anchor is `GoalflowFocusSessionStore` SharedPreferences with read-back verification. Mac adopts same pattern with injected `Clock`.
- Duration lives in `extraJson.duration` web/Android, default 25m. Tasks without duration are stopwatch mode (not needed in v1; default 25).
- Tests/CI: `npm test` (68 web), native 44 JVM tests, no Mac CI yet — added `xcodebuild test` locally.
- Tahoe target is macOS 26, Apple Silicon only, but SDK 26.5 still reports deployment 15.0 as min — keep 15.0 for dev ease, raise to 26 at hardening.

---

## Files / directories created

```
macos-native/
  project.yml                         # XcodeGen spec (generates .xcodeproj)
  GoalflowMac.xcodeproj/              # Generated — do not hand-edit; re-run `xcodegen generate`
  GoalflowMac/
    Resources/Info.plist
    App/AppDelegate.swift
    App/GoalflowMacApp.swift
    Domain/GoalflowTask.swift
    Domain/ExecutionState.swift
    Services/Clock.swift
    Services/ExecutionTimer.swift
    Services/FocusSessionStore.swift
    Providers/CurrentTaskProvider.swift
    UI/ExecutionPanelView.swift       # ViewModel + Panel (Tahole calm)
    UI/MenuBarController.swift
    UI/Components/FrogBadge.swift
    UI/Components/CircularProgress.swift
  GoalflowMacTests/
    ExecutionStateTests.swift
    FocusSessionStoreTests.swift
    ExecutionTimerTests.swift
    SchedulingTests.swift
docs/
  MACOS_EXECUTION_COMPANION_PLAN.md  # Master plan (13 sections)
  MACOS_EXECUTION_COMPANION_HANDOFF.md # This file
```

- Removed spurious `/macos-native/.ids.json` if present (was temp). `GoalflowMac.xcodeproj` is generated; commit it (or note to regenerate via xcodegen).
- No Web/Android/server files touched.

---

## Tests / build commands run and results

```bash
# Session A
git fetch origin                             # ok, recorded f93684a
git checkout -b feature/macos-execution-companion f93684a  # created
xcodegen install (brew, 2.46.0)
xcodegen generate --spec macos-native/project.yml --project macos-native
  => Created project at macos-native/GoalflowMac.xcodeproj
xcodebuild -project ... -scheme GoalflowMac -configuration Debug build  # Session A
  => BUILD SUCCEEDED (arm64)
xcodebuild test ... -destination 'platform=macOS'  # Session A
  => Executed 13 tests, 0 failures

# Session B (verified 2026-08-30 on Xcode 26.6 / SDK 26.5 / Swift 6.3.3 / arm64)
xcodegen generate --spec macos-native/project.yml --project macos-native
xcodebuild -project ... -configuration Debug build => BUILD SUCCEEDED
xcodebuild -project ... -configuration Release build => BUILD SUCCEEDED
xcodebuild test ... -destination 'platform=macOS'
  => Executed 26 tests, 0 failures (ExecutionStatePause 9, ExecutionState 5, Timer 2, FileStore 3, Store 3, Monotonic 1, Scheduling 3)

# Session C (verified 2026-08-30 on Xcode 26.6 / SDK 26.5 / Swift 6.3.3 / arm64)
xcodegen generate --spec macos-native/project.yml --project macos-native
  => Created project at macos-native/GoalflowMac.xcodeproj
xcodebuild -project ... -configuration Debug build => BUILD SUCCEEDED
xcodebuild -project ... -configuration Release build => BUILD SUCCEEDED
xcodebuild test ... -destination 'platform=macOS'
  => Executed 36 tests, 0 failures (3 runs clean)
  Suites:
    CompletionHoldTests: 4 passed (3s/5s, progress, cancel, frog 5s)
    FlowStateTests: 3 passed (allCases, withCompleted preserves, withFlowState merges)
    TaskCompletionPersistenceTests: 3 passed (complete persists before next, no resurrection, only open)
    ExecutionStatePauseTests: 9 passed
    ExecutionStateTests: 5 passed
    ExecutionTimerTests: 2 passed
    FileFocusSessionStoreTests: 3 passed
    FocusSessionStoreTests: 3 passed
    MonotonicClockTests: 1 passed
    SchedulingTests: 3 passed

# Session D (verified 2026-08-30 on Xcode 26.6 / SDK 26.5 / Swift 6.3.3 / arm64)
xcodegen generate --spec macos-native/project.yml --project macos-native
  => Created project at macos-native/GoalflowMac.xcodeproj
xcodebuild -project ... -configuration Debug build => BUILD SUCCEEDED
xcodebuild -project ... -configuration Release build => BUILD SUCCEEDED
xcodebuild test ... -destination 'platform=macOS'
  => Executed 45 tests, 0 failures (3 runs clean)
  Suites:
    BreakStateTests: 3 passed (durations, remaining/expired, open never expired)
    BreakSessionStoreTests: 2 passed (file persists, open persists)
    BreakTimerTests: 2 passed (counts, open elapsed)
    BreakReturnTests: 2 passed (pause-before-break freeze, break does not bleed)
    CompletionHoldTests: 4 passed
    FlowStateTests: 3 passed
    TaskCompletionPersistenceTests: 3 passed
    ExecutionStatePauseTests: 9 passed
    ExecutionStateTests: 5 passed
    ExecutionTimerTests: 2 passed
    FileFocusSessionStoreTests: 3 passed
    FocusSessionStoreTests: 3 passed
    MonotonicClockTests: 1 passed
    SchedulingTests: 3 passed

# Session E (verified 2026-08-30 on Xcode 26.6 / SDK 26.5 / Swift 6.3.3 / arm64)
xcodegen generate --spec macos-native/project.yml --project macos-native
  => Created project at macos-native/GoalflowMac.xcodeproj
xcodebuild -project ... -configuration Debug build => BUILD SUCCEEDED
xcodebuild -project ... -configuration Release build => BUILD SUCCEEDED
xcodebuild test ... -destination 'platform=macOS'
  => Executed 78 tests, 0 failures (3 runs clean)
  Suites:
    CaptureViewModelTests: 7 passed (needsDate, parsed date, picker ADD, month future, notes+URL, privacy blank, empty title)
    CaptureServiceTests: 6 passed (ADD persists+no resurrection, empty title, tail, month future+time validation, URL notes tags, day time validation)
    CaptureParserTests: 13 passed (@25m, 1h 15m, natural, #tag, https, *f/@quick, day, future month, current month nil, 14:30, month drops time, collapse, empty title)
    SchedulingBridgeTests: 7 passed (day valid/invalid, month future/currentRequiresDay, month+time invalid, time format, isRealDay/isRealMonth/monthOf)

# Session F (verified 2026-08-30 on Xcode 26.6 / SDK 26.5 / Swift 6.3.3 / arm64)
xcodegen generate --spec macos-native/project.yml --project macos-native
  => Created project at macos-native/GoalflowMac.xcodeproj
xcodebuild -project ... -configuration Debug build => BUILD SUCCEEDED
xcodebuild -project ... -configuration Release build => BUILD SUCCEEDED
xcodebuild test ... -destination 'platform=macOS'
  => Executed 98 tests, 0 failures (3 runs clean)
  Suites:
    PlanningGateTests: 8 passed (monthly blocks, future month not, overdue, queue without plan, ready when matches, ignores completed, empty, order mismatch)
    LocalBreakdownTests: 6 passed (closes parent+2 children plannedOrder 0/1, empty fails, >50 fails, preserves plan, parent not open fails, stub suggest empty)
    CalendarTests: 6 passed (no time nil, month nil, mock overlap 14:30, no collision, interval 14:30-14:55, requestAccess false)
    CaptureViewModelTests: 7 passed

# Session G (verified 2026-08-30 on Xcode 26.6 / SDK 26.5 / Swift 6.3.3 / arm64)
xcodegen generate --spec macos-native/project.yml --project macos-native
  => Created project at macos-native/GoalflowMac.xcodeproj
xcodebuild -project ... -configuration Debug build => BUILD SUCCEEDED
xcodebuild -project ... -configuration Release build => BUILD SUCCEEDED
xcodebuild test ... -destination 'platform=macOS'
  => Executed 127 tests, 0 failures (3 runs clean)
  Suites:
    StableJsonTests: 3 passed (sorts keys, nested, nil/array)
    SyncMetaTests: 3 passed (empty meta 2/0, duplicate mutation throws was not changed, schema mismatch throws)
    BuildStagingTests: 5 passed (noop when equal, per-record diff 1, added, deleted deletedAt now, singleton)
    ReadyOutboxTests: 3 passed (dependency gate m1->m2 only m1 ready, one-per-entity limit 1, sort version→id)
    ApplyPushResultsTests: 6 passed (accepted proves and clears, stableJson mismatch throws, serverVersion 0 when accepted throws, replayMismatch true throws, duplicate ack throws exactly, exact ack required throws)
    ApplyRemotePageTests: 6 passed (cursor moved backwards throws, stale serverVersion 3 <=5 throws, duplicate serverVersion 1 throws, skip 10!=5 throws, pull creates conflict when pending + cursor advances, upsert when no pending values tasks)
    ChaosTests: 1 passed (20 sequences build→append→ready→push accept)
    TwoDeviceTests: 2 passed (completed never resurrects pull:tasks:t1:1 conflict + cursor 1, conflict keep local vs cloud baseServerVersion 1)
    CaptureServiceTests: 6 passed
    CaptureParserTests: 13 passed
    SchedulingBridgeTests: 7 passed
    BreakStateTests: 3 passed
    BreakSessionStoreTests: 2 passed
    BreakTimerTests: 2 passed
    BreakReturnTests: 2 passed
    CompletionHoldTests: 4 passed
    FlowStateTests: 3 passed
    TaskCompletionPersistenceTests: 3 passed
    ExecutionStatePauseTests: 9 passed
    ExecutionStateTests: 5 passed
    ExecutionTimerTests: 2 passed
    FileFocusSessionStoreTests: 3 passed
    FocusSessionStoreTests: 3 passed
    MonotonicClockTests: 1 passed
    SchedulingTests: 3 passed
```

- Not run: manual UI launch (LSUIElement appearance) requires user to run `.app` and inspect menu bar; `xcodebuild` proves compilation. Subsequent manual smoke recommended but not automated.
- `npm test` not re-run for web (out of scope Session A). Can verify `npm test` still passes if desired.

---

## Known defects / limitations (A+B+C+D+E+F remain) + G updates

- Deployment target still 15.0 not 26.0 — intentional (see plan §22).
- `xcodegen` still required to regenerate `.xcodeproj` after `project.yml` edits.
- Timer via Combine (B); hold 50 Hz; break 1 s; capture Carbon hotkey; gate `getPlanningGate` + `DailyPlanStore` + `Keychain SecItem`; breakdown Server+Local + `Calendar EKEventStore`; sync `SyncEngine` `stableJson` `SyncMeta` `BuildStaging` `readyOutbox` `applyPushResults` `applyRemotePage` `SyncTransport` `Bearer` `StoreBridge`.
- Persistence 8 files: `execution.json` + `goalflow.tasks.json` (+ sync staging) + `break.json` + `dailyPlans.json`/`goals.json`/`truenorth.json`/`amalgam.json` + `sync.json` (+ `sync WAL` `UserDefaults`) each atomic+WAL+read-back. All verified.
- Overtime distinct `+mm:ss` orange; completion via hold 3 s/5 s Frog; flow picker blocks next until `1-4`/`Esc`.
- Break: `Take Break` teal capsule when active/paused; picker `5/10/15/20/Open`; cover per-screen `level=.screenSaver` `.canJoinAllSpaces` `.stationary` `.fullScreenAuxiliary`, `frame=screen.frame` (covers menu bar), `orderFrontRegardless`, `NSApp.activate`. Alarm `alarm(loop:true)` 6-beep 880 Hz square, loops 2×; `stopAlarm` on early end. Sleep during break counts for break but not focus (paused freeze).
- Capture: `⌘⇧G` Carbon `RegisterEventHotKey` `kVK_ANSI_G cmd+shift` summons centered `NSPanel` `level=.floating` `canJoinAllSpaces` `ultraThin` `520pt` `<200ms` `CACurrentMediaTime`; `Esc` hides, break suppresses capture. `Select date` factory until `Enter` → inline `DatePicker.graphical` / month `Picker 12` `>currentMonth`. Chips preview `25m/#tag/date/14:30/🔗`. `ADD` accent `ACTION` green deferred if active or future month. Notes `⌘↵` reveals `TextEditor` merged with `https://`. `TagRoutingService` `UserDefaults goalflow.hashtag.routes.v1` → `NSWorkspace.open` lowercased. `PrivacyGateway` blanks `••••` when `CGWindowListCopyWindowInfo` finds sharing.
- Gate wall blocks `ACTION`/`Break` when `monthly/daily` required; `Open Web Plan` `NSWorkspace.open` `?view=planning`; no local plan edit yet (web only).
- Breakdown: `Break down into next actions` indigo capsule → sheet `AI suggestions` `ProgressView` 429/503 orange, staged `trash`, `Confirm` closes `broken_down` `parentTaskId` `plannedOrder` tail, preserves plan when `taskIds==queueIds` else deletes; `ACTION` while gated does not preempt.
- Calendar: `Check calendar` button when `scheduledTime` but `notDetermined`; amber `Overlaps calendar` capsule when `requestFullAccessToEvents` authorized and `!isAllDay && start < taskEnd && end > taskStart`; denied shows nothing.
- Auth: `Sign in` vs `checkmark.shield` header, `Menu Sign in…/Sign out` `KeychainSessionStore.clear`, `ASWebAuthenticationSession` `goalflow://auth/callback` `code_verifier` `PKCE` vs `#access_token` fragment fallback, `local-demo` Bearer when `ENABLE_LOCAL_DEMO` and no Keychain.
- Sync: `SyncEngine` push loop `readyOutbox 50` `POST /sync/push` `applyPushResults` exact proof `stableJson` `replayMismatch` `exactly`, pull loop `GET /sync/pull?cursor&limit=100` `nextCursor==max(serverVersion)` `moved backwards`/`stale`/`duplicate`/`skip` throws, `sync.json` `SyncMetaStore` `DeviceId` `UserDefaults`, `FileSyncStoreBridge` `goalflow.tasks.json` etc `Data.write(.atomic)` bypass staging on remote apply, `TaskStore.saveAll` stages `buildStagedLocalTransaction` per-record `appendStagedTransactions` best-effort before file write, conflicts sheet `Keep local` retry `resolvesConflictId` vs `Use cloud` `serverPayload` upsert, periodic `Timer 300s` `triggerSyncIfNeeded` when `isAuthenticated`, 401/403 → `AuthenticationExpiredDuringSync` preserves outbox.
- No `undo` after completion; no break stats `trackBreak` local-only (not in `STORES.STATS`).
- No idle/away reconciliation dialog yet (stretch for D, B observers already recompute).
- AppIcon still deferred to H.

---

## Architectural decisions made

- Use `XcodeGen` (installed via brew) to keep `project.yml` as source of truth, avoiding hand-edit `pbxproj` fragility.
- Adopt injected `Clock` + `ManualClock` for deterministic tests; production uses `SystemClock` (`Date()`).
- Use `UserDefaults(suite)` for demo persistence to avoid entitlements/file coordination in v1.
- Keep `GoalflowTask` `durationMinutes` explicit int (not buried in `extraJson`) for timer logic, but retain `extraJson` field for round-trip preservation when sync arrives.
- LSUIElement accessory policy set in `AppDelegate.applicationDidFinishLaunching` (`NSApp.setActivationPolicy(.accessory)`) to ensure no Dock icon even if Info.plist fallback.
- Keep `GoalflowMacTests` as bundle unit-test with `GENERATE_INFOPLIST_FILE=YES` to satisfy code-sign requirement.

---

## Cross-platform contracts discovered

- Task queue order must match `compareQueueCandidates` exactly; Swift port verified with frog ranking test (beforeFrog habit = 0, frog =1, ordinary =2). Future property test should expand.
- Duration default 25m; stored opaque in web/android but exposed for timer. Preserve not to rewrite.
- Completion semantics not implemented yet; placeholder — when added must bump `version`, write `completedAt`, enqueue mutation before celebration, per Android `completeTask`.
- No server ACTION semantics yet — local transition only. Gateway `NoopSyncGateway`/`StubAuthGateway` placeholders in place.

---

## What could not be tested

- Visual pixel correctness of Tahoe glass (requires manual screenshot on Tahoe 26).
- Actual menu-bar truncation on small notch vs ultra-wide.
- Sleep/wake recomputation fidelity (no sleep simulation harness in v1).
- Process kill recovery across real `SIGKILL` vs XCTest UserDefaults suite (tested with separate suite domain but not with real app termination).

---

## Exact recommended scope for Session G — DONE

**Completed 2026-08-30 — verified above (127 tests, BUILD SUCCEEDED, DoD met).**

Next scope moves to **Session H — Hardening (ship quality)** (bounded, final):

1. `LoginItem` `SMAppService` `launchAtLogin` toggle in `Settings` + `MenuBarController` `checkForUpdates` `Sparkle` feed `appcast.xml`.
2. Hardened Runtime entitlements `com.apple.security.app-sandbox` `com.apple.security.personal-information.calendars` `keychain-access-groups` `com.mariusschober.goalflow.mac` + `com.apple.security.network.client` for sync, `CODE_SIGN_IDENTITY` `Apple Development` + `notarization` `xcrun notarytool` `stapler`.
3. Privacy: `ScreenCaptureKit` `CGWindowListCopyWindowInfo` replaced with `SCShareableContent` `includesCurrentDisplay` for `PrivacyGateway` when sharing, `NSPrivacyAccessedAPICategory` `NSPrivacyCollectedDataTypes` `PrivacyInfo.xcprivacy`.
4. Multi-display/Spaces polish: `BreakCover` `NSScreen.screens` `didChangeScreenParameters` already, `Capture` `NSScreen.main` centering already, `a11y` `VoiceOver` `accessibilityLabel` for `Current`/`Timer`/`Break`/`Gate`/`Conflicts`, `AX` roles, `NSAccessibility` `accessibilityPerformPress` for hold.
5. Performance: `ExecutionTimer` 1s not 250ms, `SyncEngine` `Timer 300s` not busy, `stableJson` cached, release packaging `DMG` `create-dmg` + `final merge to production` `git merge --no-ff feature/macos-execution-companion` `origin/goalflow-production`.

**Session H definition of done:** `LoginItem` enabled, `Sparkle` updates, `HardenedRuntime` `notarized` `spctl -a -vv` passes, `PrivacyInfo` present, `a11y` `VoiceOver` reads `Current` + `Break` + `Gate`, `performance` <50ms panel open, `DMG` `GoalflowMac.dmg` `codesign -vv` passes, merge to `goalflow-production` green, no silent data loss.

---

## Handoff checklist for next agent (Session H)

- [ ] Verify branch `feature/macos-execution-companion` tip (check `git merge-base` equals `f93684ac50562c03c99328d98e57eb67f862eb3b`); record `git rev-parse HEAD`.
- [ ] Run `xcodegen generate --spec macos-native/project.yml --project macos-native/` if `project.yml` changed.
- [ ] Run `xcodebuild test -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -destination 'platform=macOS'` and expect 127 passing.
- [ ] Do not modify `android-native/` (read-only) but `services/syncProtocol.ts` parity already mirrored — hardening is next (H) with `LoginItem`/`Sparkle`/`HardenedRuntime`.
- [ ] Read `docs/MACOS_EXECUTION_COMPANION_PLAN.md` §10 (Session H) and §22 before coding; respect `LSUIElement` + sync `SyncMeta` `stableJson` `cursor` monotonicity + `Keychain` + `EventKit`.

---

## Commands for quick start (copy-paste)

```bash
git fetch origin
git rev-parse origin/goalflow-production # confirm still f93684a or note drift
git checkout feature/macos-execution-companion

xcodegen generate --spec macos-native/project.yml --project macos-native/
xcodebuild -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -configuration Debug build
xcodebuild test -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -destination 'platform=macOS'

open macos-native/GoalflowMac.xcodeproj # manual UI smoke
# Then Product > Run, check menu bar "scope" icon appears top-right, click → panel shows "Draft Q4 roadmap…", press ACTION → active ring counts down, quit and reopen → timer recovers
```
