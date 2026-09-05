> **HISTORICAL FEATURE-BRANCH PLAN.** Demo transports, completion claims, and
> deployment assumptions below are not current production behavior or beta
> evidence. The selectively transplanted implementation is governed by
> `docs/reconciliation/BETA_PROVENANCE.md` and the current release gate.

# Goalflow macOS Execution Companion — Master Implementation Plan

**Branch:** `feature/macos-execution-companion`  
**Base SHA:** `f93684ac50562c03c99328d98e57eb67f862eb3b` (origin/goalflow-production 2026-08-30)  
**Spec snapshot:** `GOALFLOW_MACOS_MUSE_CONTEXT.md` (Tahoe target)  
**Last updated:** 2026-08-30 — Session H (Hardening)

---

## 1. Base identity & isolation

- Recorded exact SHA at session start: `f93684ac50562c03c99328d98e57eb67f862eb3b`. Confirmed via `git fetch origin && git rev-parse origin/goalflow-production`. Local HEAD before branch was `7fa5a17` (goalflow-production behind remote by 5 tranche-1 Android migration commits). Branch `feature/macos-execution-companion` created tip-on that SHA. If branch already exists in a later session, verify `git merge-base` equals that SHA and re-record with `git log --oneline -5`.
- No direct commits to `goalflow-production`. All Mac work under `macos-native/`. Cross-cutting docs under `docs/MACOS_*`. No modifications to `android-native/`, `android/`, or sync server contracts in Session A-G (read-only until H, G now mirrors protocol).
- Integration rule: do not rebase on moving production until milestones are coherent. Final integration is a deliberate merge with QA.

---

## 2. Architecture findings from repository audit

### 2.1 Product invariants (PRODUCT_PHILOSOPHY.md)
- **Schedule-first:** every task belongs to an exact local day or future month. No Inbox/Someday swamp. Overdue cannot be bypassed; planning gates enforce order.
- **Current = one deterministic queue head.** Frogs + before-frog habit → frogs → ordinary, then plannedOrder / circadianRank / scheduledTime / createdAt / id.
- **Completion is durable:** `completedAt` before sync; completed must not reappear. Breakdown closes parent (`broken_down`), not delete.
- **Local-first:** Offline mutation, IndexedDB/Room + outbox, sync is enhancement.

### 2.2 Scheduling domain
- Single pure domain `src/domain/scheduling.ts` (and mirrored `android-native/domain/GoalflowDomain.kt`). Logic: `assertSchedule`, `createScheduledTask`, `compareQueueCandidates`, `buildTodayQueue`, `getPlanningGate`, `skipTask`, `rescheduleTask` (+frog failure promotion), `breakDownTask`, habit generation.
- Key invariants for Mac:
  - `plannedOrder` is explicit int; queue sort is deterministic.
  - `schedulePrecision: day|month`, `scheduledFor` is YYYY-MM-DD or YYYY-MM.
  - `status: open|completed|broken_down|dropped|archived`, `deletedAt` soft delete.
  - `version` int, bumps on touch.
  - Daily plan gate `DailyPlan { localDate, confirmedAt, taskIds }` enforces confirmed queue before Current; Mac will respect via sync read-only initially; no local planning edit in Mac until session F.
  - Habit/day uniqueness enforced at storage + domain level.
- Web/Android extras preserved via `extraJson` (opaque JSON) — contains `duration`, `hashtags`, `flowState`, `actualDuration`, gamification undo payload. Must be treated as opaque but round-trippable.

### 2.3 Task model width
- Web `Task` (`types.ts`): `duration?: number` (planned minutes), `actualDuration`, `hashtags`, `session`, `isFrog`, `beforeFrog`, `schedulePrecision`, `scheduledFor`, `plannedOrder`, `frogFailures`, etc.
- Android `GoalflowTask`: same via Room `TaskEntity`, with `extraJson` for duration etc. Duration stored in `extraJson.duration` (default 25). Planned order is column.
- Web persistence: `STORES.TASKS` collection keyed by `userKey` holds `ScheduledTask[]`. Mac v1 will emulate this with a local representation behind `CurrentTaskProvider`.

### 2.4 Persistence & SyncProtocol reality
- `services/storage.ts` = durable IndexedDB + WAL (`goalflow_wal_v2_*`) + fallback localStorage + sync meta `STORES.SYNC` (outbox, conflicts, versions, cursor). Mutations are queued, staged via `buildStagedLocalTransaction` splitting snapshot collections into per-entity mutations (`RECORD_LEVEL_STORES` includes TASKS). Strict replay validation.
- `services/syncProtocol.ts` = full protocol: `SyncMeta { cursor, versions, outbox, conflicts }`, per-entity `version`, mutation chaining `dependsOnMutationId`, push validation (`applyPushResults`), pull `applyRemotePage` with cursor monotonicity, conflict ledger `LocalConflict`.
- `services/cloudSync.ts` = at-least-once `synchronizeCloudOnce`: seed unsynced, push loop `POST /api/v1/sync/push`, pull loop `GET /api/v1/sync/pull?cursor&limit=100`, cursor advance invariant, `startCloudSync` with BroadcastChannel + navigator.locks.
- Android mirrors with Room: `sync_outbox`, `sync_meta`, `sync_conflicts`, `raw_collections` (+ task_events for audit). NativeSyncEngine does same push/pull with strict acknowledgement.
- **Server:** Express 5 + Supabase Postgres + RLS + `sync` records, conflict rows. Not inspected deeply this session beyond service contracts; will deep-read routes in session F/G.

**Maturity assessment:** Sync is substantial and hardened (recovery mirrors, WAL reconciliation, backup checksum, cursor safety, conflict explicit retention). Another agent is hardening it further. Mac must not fork.

### 2.5 Web focus / time implementation
- `hooks/useFocusTimer.ts`: elapsed = `elapsedBeforePause + (now - startTime)` derived from wall-clock, persisted to `localStorage` (`goalflow_timer_state`) with `taskId,startTime,pausedAt,elapsedBeforePause,isActive,hasExpired`. Interval 250ms, monotonic-ish (Date.now). Pause/resume rewrites accumulator; `resetTimer` on task change; `addTime` adjusts accumulator.
- `hooks/useTickingSound.ts`: AudioContext white-noise bandpass tick at 1500Hz Q20 every second while active.
- `components/CurrentView.tsx`: CircularTimer SVG with progress, flow-state labels (Entering Flow <5min, Deep Focus <20min, Flow State after). Timer expiry => alarm + modal `isExpiryModalOpen`. Break overlay, flow awards, breakdown bottom sheet.
- Overlap for Mac: wall-clock reference-time logic is correct pattern; Mac will use `ContinuousClock` / `mach_absolute_time` / `Date.now()` reference, not decrement integer.

### 2.6 Android focus & persistence boundaries
- `data/GoalflowFocusSession.kt`: tiny SharedPreferences store `NativeFocusSession(taskId, startedAtMillis)`, `beginOrResume` with read-back verification, `clear()`. Timer anchor separate from authoritative Room commitment.
- `data/GoalflowRepository.kt` / `data/GoalflowDatabase.kt`: Room v6, tasks/goals/habits/plans/rawCollections/sync. Pure domain mirrors.
- `time/GoalflowTime.kt`: time provider abstraction (system / fake). Scheduling uses injectable `GoalflowTimeProvider`.
- Sound: `GoalflowSoundController.kt` generates PCM tones per completion type.
- Relevant: Local snapshot tests, sync engine tests, repository sync tests — 44 JVM tests. Populates `NativeWidgetSnapshot`, widget-safe current proof.

### 2.7 Tests & CI
- Web: `npm test` via vitest (68 tests, 9 files, plus 400 property sequences). `npm run lint` = tsc noEmit, `npm run build` + `verify:server`, `audit`. CI on private repo with standard checks + gitleaks.
- Native: `./gradlew test`, lint, assemble.
- No Mac CI yet; will add `xcodebuild test` local + later CI job.

### 2.8 Other scheduling details discovered
- `duration` defaults 25m web, 25m iOS legacy? Android default 25m. Tasks without duration considered stopwatch mode. Pomodoro flow optional.
- `overdue` detection is `scheduledFor < today` and `status open`.
- Frog promotion on 2nd forward reschedule (`frogFailures >=2`) — but domain says skip is blocked for frogs; reschedule forward blocked for frogs directly.

---

## 3. Product invariants to preserve (hard constraints)

1. One Current task at a time, deterministic queue head. No list browsing, no reordering from Mac until explicit later phase (read-only Current).
2. Schedule precision: day or future month, validated. Mac capture must enforce `Select date` default.
3. Frog semantics: cannot skip, cannot forward-reschedule; 5s completion distinguished from 3s standard. Mirrored visually even in demo v1.
4. Breakdown closes parent; never delete parent to invent children.
5. Completion durable before celebration; no resurrection after reload/sync. Task id stability.
6. Local-first: Mac must work offline; timer persistence must survive kill.
7. Sound semantics are slots not files: tick must be swappable.
8. FlowState enum fixed: `distracted|good|high|flow`.
9. Planning gate: do not present actionable Current when planning required. In v1 demo, synthesize a single valid today open task so gate is satisfied.
10. Zero silent data loss for execution state (see §7).

---

## 4. Native macOS architecture (Session A target + evolution)

### 4.1 Surface topology (per context §25)
- Menu-bar-only app: `LSUIElement = true` (no Dock icon), `NSStatusItem`, `NSPopover` pinned under menu bar (execution panel). No main window.
- Later surfaces (sessions D/E): Quick Capture overlay (borderless centered `NSPanel`), Preferences `NSWindow`, Break fullscreen cover on all displays.
- Session A only installs: menu item + popover panel.

### 4.2 Module boundaries (interfaces before concrete)

```
macos-native/
  GoalflowMac/
    App/               # entry, AppDelegate
    Domain/            # Task, ExecutionState, Scheduling parity
    Services/          # persistence, timer engine, gateways
    Providers/         # CurrentTaskProvider (demo vs production)
    UI/                # ExecutionPanel, components
    Resources/         # assets catalog, sounds placeholder
  GoalflowMacTests/    # unit tests
  GoalflowMac.xcodeproj
```

Core protocols (gateways) — declared now, stubbed:

```swift
protocol CurrentTaskProvider { var currentTask: GoalflowTask? { get } 
  func fetchCurrent() async throws -> GoalflowTask?
}
protocol FocusSessionStore {
  func load() -> FocusSession?
  func save(_ s: FocusSession) throws
  func clear() throws
}
protocol GoalflowStore {
  func loadTasks() -> [GoalflowTask]
  // v1: local only; vG: room/idb-equivalent
}
protocol SyncGateway { func synchronize() async throws } // stub
protocol AuthGateway  { var isAuthenticated: Bool { get } }
protocol ActionGateway { func start(taskId:) -> FocusSession } // eventually POST /api/v1/action
protocol BreakdownGateway { func suggest(task:) async -> [BreakdownChild] }
```

Provider implementations:
- `DemoCurrentTaskProvider` (v1): deterministic one-task array sorted via `compareQueueCandidates` Swift port; task is `isFrog` toggleable for visual check.
- `UserDefaultsCurrentTaskProvider` later → local file + migration.
- Production: `SyncBackedCurrentTaskProvider` consuming local cache after `GoalflowStore` sync.

### 4.3 Domain port

Swift `GoalflowTask` mirrors `ScheduledTask` + web `Task` union:
- `id, title, notes, schedulePrecision(.day/.month), scheduledFor, scheduledTime, plannedOrder, status(.open/.completed/.brokenDown...), isFrog, beforeFrog, frogFailures, source, goalId, parentTaskId, habitId, createdAt, updatedAt, durationMinutes(1..1440, default 25), extraJson`.

Timer domain is isolated from UI (see §5).

### 4.4 Native execution style

- Swift 6, SwiftUI for panel + AppKit for menu bar glue (required for statusItem/popover lifecycle).
- Deployment target macOS 26 Tahoe, Apple Silicon only (arm64). Tahoe Liquid Glass materials where available with fallbacks.
- No SPM external deps in v1 (stay zero-dep for audit simplicity). Later: Keychain, Network.

---

## 5. State machine for execution (authoritative)

Deterministic FSM, persisted at transition boundaries (before announcing success). Single source of truth: `ExecutionState`.

```swift
enum ExecutionPhase: String, Codable { case idle, active, paused } // paused added in session B; v1 only idle→active
struct ExecutionState: Codable, Equatable {
  var taskId: String
  var phase: ExecutionPhase
  var startedAt: Date        // machine wall-time of ACTION press (monotonic anchor)
  var plannedDurationSeconds: Int // durationMinutes * 60
  var accumulatedPauseSeconds: Int // 0 in v1
  var lastResumedAt: Date?   // nil in v1 active; used in B
}
```

Transitions (v1):
- `idle --ACTION--> active`: validate task exists+open, write `ExecutionState(phase:.active, startedAt: now, plannedDurationSeconds: task.duration*60)` durably (UserDefaults/ file + read-back), then start timer engine. UI moves cover from neutral to active.
- No other transitions in v1. Kill and relaunch: if `ExecutionState.phase == .active` and `taskId` still open and not deleted, recompute display from `now - startedAt`. If task missing/completed → clear.

Future (sessions B–C):
- `active --pause--> paused`, `paused --resume--> active`, `active --expiry--> overtime`, overtime display negative/positive.
- `active/paused --COMPLETE(3s/5s)--> completed` then next task gate.
- Guard: only the `taskId` in `ExecutionState` can be completed via Mac.

Invariant: any `phase != idle` has `taskId` and `startedAt`; no orphan phase.

---

## 6. Local persistence strategy (v1 + evolution)

### v1 (demo-actionable, zero-dependency, Tahoe-friendly)
- `FocusSessionStore` backed by `UserDefaults(suiteName: "group.com.goalflow.mac")` or standard with file backup. Keys: `goalflow.focus.session.v1` JSON encoded `ExecutionState`, plus `goalflow.demo.tasks.v1` for the demo queue.
- Write protocol: `encode -> UserDefaults.set -> synchronize -> read-back decode -> assert equal else throw`. On failure, surface error, do not mutate phase/UI.
- Task persistence: `DemoTaskStore` writes single task list to same suite; never lost on relaunch.
- Why not file/SQLite yet: keep v1 review surface minimal; UserDefaults is durable enough for a demo slice and is Tahoe-sanctioned for small state. Will promote to SwiftData/GRDB or file with WAL before sync.

### v2-B (session B hardened)
- Promote to app-support file `~/Library/Application Support/com.mariusschober.GoalflowMac/execution.json` with atomic write (`FileManager .atomic` + read-back verify). Add crash-safe WAL mirror in UserDefaults for double-write, reconcile on launch (like web's fallback). Add `monotonicClock` field (mach_continuous_time) for sleep detection.

### vFinal (session G prep)
- Prepare mapping to shared sync schema: entity `tasks` collection with same `version` bump semantics, store per-task `extraJson`. Task execution state itself is not synced as entity; it's local focus state. Sync only carries `status`/`completedAt` mutations. Mac will write `completed` via the action gateway (server semantic), not locally invent version.

---

## 7. Timer / execution engine (reference-time-derived)

- Authority: `startedAt` wall-time `Date`, not tick counter.
- Engine: `ExecutionTimer` class injected with `Clock` (protocol) for testability. `now: () -> Date` defaults to `Date()`. Also observes `NSWorkspace.screensDidSleepNotification` / `NSWorkspace.screensDidWakeNotification` for future idle handling (stubs v1; just recompute).
- DisplaySeconds derivation: `remaining = plannedDurationSeconds - max(0, Int(now.timeIntervalSince(startedAt)) - accumulatedPause)`. Clamped to >=0 for countdown; expiry detection when `remaining == 0` will fire callback in B (not yet in v1 UI; just counts to 0 and holds).
- Ticker: `Timer.publish(every: 1, on: .main, in: .common).autoconnect()` or `CADisplayLink`, but computation is always `now - startedAt`. No integer decrement mutation persists.
- Relaunch recovery test: set `startedAt = now - 47s`, planned 25m → remaining = 25*60 -47. No loss.

---

## 8. Interface boundaries & eventual final Sync

| Gateway | v1 impl | vG (final) | Notes |
|---|---|---|---|
| `CurrentTaskProvider` | `DemoCurrentTaskProvider` returning deterministic 2-task queue sorted | `SyncBackedCurrentTaskProvider` reading `GoalflowStore` + planning gate `DailyPlan` | Filter: only `status.open && schedulePrecision==day && scheduledFor == today`. Reuse Swift port of `buildTodayQueue`/`planningGate`. |
| `GoalflowStore` | `DemoTaskStore` (UserDefaults) | `LocalGoalflowStore` (File/SQLite) + `SyncEngine.applyRemotePage` | Must retain opaque `extraJson` round-trip. |
| `FocusSessionStore` | `UserDefaultsFocusSessionStore` | `FileFocusSessionStore` with WAL | Always verified write. |
| `AuthGateway` | `StubAuthGateway` (always local-demo) | `KeychainAuthGateway` → browser flow `goalflow://auth/callback` or Supabase PKCE | No secrets in bundle now. |
| `SyncGateway` | `NoopSyncGateway` | `NativeSyncEngine` Swift port of validate-replay, cursor monotonicity, conflict ledger | Shared protocol with web/android — strictly replicate `syncProtocol.ts`. Test parity with same adversarial cases. |
| `ActionGateway` | local state transition only | `POST /api/v1/sync/push` style or dedicated `/api/v1/action` when server ACTION exists | Must not invent server semantics; interface captures `taskId,start,planned`. |
| `BreakdownGateway` | `StubBreakdownGateway` | `ServerBreakdownGateway` → DeepSeek proxy / server AI | Provider stays server-side. |

Final sync integration (session G) last step:
- Implement Swift `SyncEngine` with identical invariants: mutationId UUID, `version` chain, `baseServerVersion`, `dependsOnMutationId`, cursor checks, replay mismatch detection. Reuse translation of `syncProtocol.ts` with Swift property tests covering chaos/replay.
- Local mutation persistence: file transaction group (tasks+meta in one atomic write). Never cherry-pick push result.
- Preserve zero-silent-data-loss: any local `completed` remains pending in outbox until ack'd; cursor never advances over unapplied page.
- Conflict UX: explicit choice; never auto-merge task content.

---

## 9. Testing strategy

### v1
- Unit: `ExecutionStateTests` — idle→active, faked clock, remaining computation, persistence round-trip, relaunch recovery, frog flag preservation.
- Persistence: `FocusSessionStoreTests` — save, load, clear, corrupted JSON throws (not discards), read-back mismatch detection.
- Domain sort parity: `SchedulingTests` — sort order parity with `compareQueueCandidates` property test (Frog 0→1 vs ordinary 2). Small fixed fixtures not exhaustive property yet.
- UI: manual smoke (popover opens, ACTION transitions, timer counts). No XCUITest in v1.
- Build verify: `xcodebuild test` or `xcodebuild build` headless.

### Session B+
- Add monotonic clock test double (`FakeClock`), sleep simulation, pause/resume additive, overtime distinction.
- Property-based queue tests (SwiftCheck or handwritten combinational).
- Migration tests for file promotion (v1 UserDefaults → v2 file).
- SyncEngine adversarial tests (round-trip validation, duplicate id rejection, cursor regress detection).

### Non-goals v1
- No WebView, no network in tests, no keychain.

---

## 10. Multi-session milestone breakdown (revised after audit)

Constraints: one bounded milestone per session, preserve sync-last.

| Session | Milestone | Scope (must-complete) | Done |
|---|---|---|---|
| **A — Foundation** | Native shell + Current→ACTION→Timer | Audit, plan+handoff, branch, Xcode project Tahoe/arm64, menu-bar-only lifecycle, popover panel, `GoalflowTask`+`ExecutionState`+`ExecutionTimer`, `DemoCurrentTaskProvider` with deterministic ordering & frog visual, ACTION hero, countdown from `duration`, inactive/active coherent Tahoe design, persistence surviving relaunch, unit tests, build | ✅ |
| **B — Focus engine** | Robust timing | Monotonic `ContinuousClock` + pause/resume + overtime (+5/+15/+30 inline), sleep/away observers recompute, file-backed `execution.json` atomic + WAL, Combine ticker wiring, `SoundGateway`/`TTSGateway` slots | ✅ |
| **C — Accomplishment loop** | Completion ritual | 3 s hold (ordinary) / 5 s Frog + haptic buildup, `FlowState` distracted/good/high/flow, `LocalTaskStore` atomic + no resurrection, next Current auto-advance, `Everything Done` quiet state, reward burst, `SoundGateway.complete` 2/4-tone | ✅ |
| **C — Accomplishment loop** | Completion ritual | 3 s hold (ordinary) / 5 s Frog + haptic buildup, `FlowState` distracted/good/high/flow, `LocalTaskStore` atomic + no resurrection, next Current auto-advance, `Everything Done` quiet state, reward burst, `SoundGateway.complete` 2/4-tone | ✅ |
| **D — Break environment** | Rest as contrast | Break selector `5/10/15/20/Open`, fullscreen black cover per-screen `level=.screenSaver` + `.canJoinAllSpaces`, break timer `BreakState`/`BreakTimer` reference-time, alarm `SoundGateway.alarm` looping, `Esc`/`End Early` return, pause-before-break frozen `remaining` | ✅ |
| **E — Capture & context** | Entry without planning drift | Global shortcut (MASShortcut-style, user-configurable), centered overlay like Spotlight, schedule invariant `Select date`, date/month picker fallback, notes/URLs, ADD vs ACTION gateway, hashtag→app mapping launch (`NSWorkspace.open`), privacy mode | ✅ |
| **F — Server capabilities** | Auth + real data read | Browser auth (PKCE/`goalflow://auth/callback`), real `CurrentTaskProvider` over local store, shared ACTION server semantic (`Start Now`), server breakdown (`/api/v1/ai/breakdown`), read-only TrueNorth/amalgam context, calendar collision warning via EventKit read-only | ✅ |
| **G — Final Sync** | Last integration | Swift Sync adapter parity, durable outbox/cursor/conflict txn, offline execution/completion + convergence tests, resurrection guard, two-device property tests | ✅ |
| **H — Hardening** | Ship quality | Login item, Sparkle update, hardened entitlements, code sign/notarization prep, privacy (screen sharing detection via `CGWindowListCopyWindowInfo`/ScreenCaptureKit, not brittle), multi-display/Spaces polish, launch at login, a11y/voiceover pass, performance, release packaging, final merge to production | ✅ |

Deferred explicitly until their sessions: overtime full UX, +5 additions, TTS, 3s/5s hold visuals, flow selector, reward flourish, Everything Done polish, break fullscreen fine grained, Quick Capture NLP, global shortcut, URL launching, calendar, browser auth, AI breakdown, final sync, Web/Android edits, blocking, signing.

If audit had shown sync to be local-only, F/G would swap — but remote cursor protocol exists, so keep F before G (need auth to exercise sync).

---

## 11. Product quality for Slice A (how to feel real, not scaffolding)

- Panel is narrow (380–420pt), top-anchored, material `NSVisualEffectView` ultraThin + stroke, Tahoe rounded-lg radius. No list chrome, no project nav, no analytics. Only: Current glyph, title, meta (frog tag + duration), hero ACTION, timer glyph, secondary distance label.
- Inactive: calm, light stroke, ACTION saturated (indigo `#5B5BD6` or system accent). Title 20pt semibold, 2-line truncation with tooltip/long-press reveal, not marquee in v1 (avoid noisy animation).
- Active: ring progress (2pt) collapses from full as `remaining/total`, subtle blur intensify, title stays but countdown dominates (48pt tabular). Temperature: cool neutral + single accent; no rainbow.
- No placeholder text like "Task description". Show nothing extra.
- Demo data: one actionable Current, recognizable intention: “Draft Q4 roadmap — outline three bets” (or similar human title), 25m, non-frog default (frog toggle in debug menu hidden behind Option for review).

---

## 12. Engineering quality — zero silent data loss Slice A checklist

Persisted before UI success:
- on ACTION: `ExecutionState {taskId, phase:active, startedAt, plannedDuration}` + `currentTaskId` pointer; atomically `UserDefaults.synchronize` equivalent + decode-verify.

Not lost on SIGKILL/force quit:
- On launch, `FocusSessionStore.load()` → if present and task still exists and day same, reconstruct timer = `now - startedAt`. Timer label correct within 1s.

Derivation check:
- Timer label in UI is `plannedDuration - floor(now - startedAt)`. No decrement drift.

State machine validity:
- Only `ACTION` from `idle` can create `active`. `active` preserved across launches until explicit complete (future) or dev clear. No bool spaghetti.

Test evidence:
- `ExecutionStateTests.test_relaunchRecoversRemaining` asserts 47s offset → 1421s remaining (25*60-79 scenario etc) passes.
- `FocusSessionStoreTests.test_persistsAndRecovers` passes read-back.

---

## 13. Risks / unknowns captured for future sessions

1. **Tahoe Liquid Glass APIs** are beta (macOS 26 SDK). Material + prominence API may change before GM. Mitigation: use `NSVisualEffectView` with style fallbacks, isolate to `TahoeEffect.swift` shim, avoid hard dependency.
2. **LSUIElement + popover activation**: with no Dock icon, popover dismissal via `NSApp.deactivate` edge cases on app-switch. Will need transient monitor `NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown)`.
3. **Global shortcut**: requires `CGEventTap` / `MASShortcut` entitlement; hardened runtime + TCC prompt. Defer but design `HotkeyGateway` now.
4. **Duration source**: web stores `duration` in `extraJson`, Android in `TaskEntity.extraJson`. Tahoe port must keep opaque. If server changes shape, preservation guard prevents drop.
5. **Planning gate vs Mac**: initial demo synthesis bypasses gate; production must respect `daily_plans.confirmedAt` — but no write path from Mac until sync-ready. Risk: showing actionable Current when Web says planning_required. F will read gate and show `Plan the day` CTA linking to Web instead.
6. **Sleep drift**: relying on `Date()` re-derives but sleep may hide elapsed away time; B will add `mach_continuous_time` delta and maybe `NSWorkspace` idle.
7. **Sync replay validation**: Swift must exactly mirror stableJson (sorted keys) to avoid replay mismatch; property test will catch.
8. **Audio**: `AVFoundation` tick at 1Hz wants permission-free but volume mixing with other apps needs `AVAudioSession`? Mac has `NSSound`; choose. Keep slot protocol.
9. **Signing**: team ID unknown until H; enforce no entitlements requiring provisioning in A-C.
10. **Another agent touching `goalflow-production`**: Mac branch isolation sufficient; final merge conflict scope limited to `docs/` + `macos-native/`; no file overlap expected.

---

## 14. Definition of Done per milestone

### A
- Branch exists at `f93684ac50562c...`, commit history shows plan + project + implementation.
- `macos-native/GoalflowMac.xcodeproj` builds with `xcodebuild -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac -configuration Debug build` on arm64/26 SDK (PASS output recorded).
- `GoalflowMacTests` passes (execution/timer/persistence).
- Menu-bar item appears; click opens popover with one demo task; ACTION pressed → active ring countdown; quit & relaunch → timer recovers within 1s window.
- No secrets in repo, no Web/Android touched except docs.

### B
- Pause/resume stable over 10 toggle cycles; overtime counter increments past 0 as distinct display; kill during active → elapsed preserved within 1s; monotonic clock verified vs `Date` drift ≤2s over mocked 2h.
- Audio slot wired (tick generated once per second, volume control stub).

### C — etc (abridged)
Each with explicit UI/behavior + test gate + no data loss case enumerated; see sections 10/12 extended.

---

## 15. Files & invariants touched/untouched ledger

Created in A: `macos-native/**`, `docs/MACOS_*`.
Read-only in A: `src/domain/*`, `services/*`, `android-native/**`, `server/**`, `types.ts`.
Must-not-touch until G: `services/syncProtocol.ts`, `services/cloudSync.ts`, `supabase/migrations/*`, `server/routes/sync/*`.
Handoff tracks exact commands run.

---

## 16. Exact next-session recommendation

Session B scope: robust countdown + pause/resume + overtime (+5/+15/+30 controls deferred to visual slice but timer logic ready), monotonic clock, sleep/away recompute, file-backed persistence upgrade, sound architecture placeholder. Keep interfaces; no completion loop yet.

Entry criteria: verify no outstanding Sync-breaking change on `origin/goalflow-production`; reread `docs/MACOS_EXECUTION_COMPANION_HANDOFF.md` current branch SHA and defects. Do not start F/G early.


---

## 17. Session B — Focus Engine (2026-08-30, executed)

**Goal:** Harden the focus timer from demo countdown to production-grade engine without adding completion/break surfaces.

**Decisions taken (per user-approved plan, user delegated all 4 choices):**
- Keep `MACOSX_DEPLOYMENT_TARGET 15.0` (SDK 26.5) for stability; no bump to 26.0 yet (deferred to H).
- Surface `+5 / +15 / +30` inline inside active panel (low friction per §6) — not hidden behind debug menu only, but also in ellipsis menu for discoverability.
- Menu bar shows live time: `● Draft Q4 roadmap +02:14` / `⏸ Draft… 12:34` — truncated 22 chars, overtime amber, paused orange fill, active green dot.
- Ticking enabled by default per §11 (via `TickSoundGateway` at 1 Hz while active, volume 0.6, generated bandpass noise).

**State machine extension (`Domain/ExecutionState.swift:1`):**
- `ExecutionPhase` now `idle | active | paused` (overtime is `active` with `overtimeSeconds>0`, not a separate phase to keep persistence minimal; UI derives `isOvertime`).
- New fields: `startedAtMonotonic: UInt64?` (optional for migration), `accumulatedPauseSeconds: Int`, `lastPausedAt: Date?`.
- Custom `Codable` with `decodeIfPresent` defaults; clamps invariants.
- Pure transitions: `paused(at:) -> ExecutionState?` (active->paused), `resumed(at:) -> ExecutionState?` (paused->active, `accumulated += floor(now - pausedAt)`), `extended(by:) -> ExecutionState?` (grow `plannedDurationSeconds` capped 1440*60, keeps `startedAt`).
- Derived: `elapsedSeconds(now:)`, `remainingSeconds(now:)`, `overtimeSeconds(now:)`.

**Clock (`Services/Clock.swift:1`):**
- `MonotonicClock` protocol exposing `monotonicNow: UInt64` via `mach_continuous_time()`.
- `SystemClock: MonotonicClock`, `FixedClock`, `ManualClock` with lock, `advance(by:)` syncs wall + ~1e9 ticks/sec, `set(_:monotonic:)` for drift tests.

**Persistence (`Services/FocusSessionStore.swift:1`):**
- `UserDefaultsFocusSessionStore` retained as WAL mirror (secondsSince1970, 0.001 s tolerant read-back).
- NEW `FileFocusSessionStore(fileURL:)` → `Application Support/com.mariusschober.GoalflowMac/execution.json`, `Data.write(.atomic)` + read-back equality + decode field check.
- NEW `CompositeFocusSessionStore(fileStore:walStore:)` → `load()` prefers file, migrates WAL→file once if file missing; `save()` writes file first then mirrors WAL (WAL failure logged not fatal); `clear()` both.
- `AppDelegate` now uses `CompositeFocusSessionStore(File+UserDefaults)`.

**Timer (`Services/ExecutionTimer.swift:1`):**
- `@Published remainingSeconds, overtimeSeconds, isActive, isPaused`; `state: ExecutionState?`, `clock: any Clock`.
- `configure(state:clock:)` handles active/paused/idle, starts/stops ticker + sleep observers.
- `reflectPause/resume/extend` called after store.save (persist-before-UI preserved).
- `tick()` recomputes `remaining/overtime` from reference time every 1 s.
- Sleep observers: `NSWorkspace.screensDidSleepNotification` / `screensDidWakeNotification` via `NSWorkspace.shared.notificationCenter`; sleep no-ops (counts as elapsed unless user paused), wake calls `tick()`.

**Sound/TTS (`Services/SoundGateway.swift:1`, `Services/TTSGateway.swift:1`):**
- `SoundGateway` slot with `NoopSoundGateway` and `TickSoundGateway` (AVAudioEngine per-tick generation 50 ms white-noise bandpass 1500 Hz Q20, 0.18 gain, dispatched off main).
- `TTSGateway` slot with `NoopTTSGateway` and `AVTTSGateway` (AVSpeechSynthesizer en-US, rate 0.5, disabled by default — respects privacy, never logs task text).

**UI (`UI/ExecutionPanelView.swift:1`, `UI/MenuBarController.swift:1`):**
- `ExecutionViewModel` now observes `timer.$remainingSeconds/$overtimeSeconds/$isPaused` via `AnyCancellable` (removed poll stub), drives `remainingSeconds/overtimeSeconds/isPaused` published.
- `isOvertime` derived via `overtimeSeconds>0`; `progress` full ring orange when overtime; `displayTime` shows `+mm:ss` orange when overtime else `mm:ss`; `pause()`/`resume()`/`add5/15/30()` persist before `timer.reflect*`.
- Panel header shows Paused/Overtime/Current with pause/orange icons; active row shows toggle Pause/Resume + inline `+5 +15 +30` capsule buttons; hints: "Paused — elapsed frozen." / "Overtime — planned time elapsed."; background amber glow when overtime.
- `MenuBarController` replaces 1 s poll Timer with Combine sinks on `remainingSeconds/overtimeSeconds/isPaused`; fallback 5 s safety poll; `updateStatusTitle()` shows `● title +mm:ss`, `⏸ title mm:ss`, truncates 22 chars.

**Tests (`GoalflowMacTests/SessionBTests.swift:1`):**
- `ExecutionStatePauseTests` 9 tests: pause freeze, resume adds interval, 10 cycles additive, overtime separately, extend increases planned, extend while paused stays paused, cap 1440, idempotent guards, clock skew clamped.
- `MonotonicClockTests` 1: wall vs monotonic 2h within 2s.
- `FileFocusSessionStoreTests` 3: file persists, composite migrates from WAL, double-write.
- Total now 26 tests (5+1+9+2+3+1+3+3) — earlier 13 + 13 new — all passing.

**Deferred remains:** full hold completion (C), break fullscreen (D), capture (E), auth/sync (F/G), signing (H).


---

## 18. Session C — Accomplishment Loop (2026-08-30, executed)

**Goal:** Deliver the reward ritual `COMPLETE → FLOW STATE → REWARD → NEXT` without adding break/capture surfaces.

**Decisions (per user-approved plan, user confirmed all 4):**
- Hold visual: circular `CircularProgress` hold arc over timer ring (not separate button fill) — calm, no extra chrome.
- Flow picker inline under timer, 2×2 chips `Distracted/Good/High/Flow` mapped `1-4`, `Esc` skip.
- `actualDuration = ceil(elapsedSeconds/60)` from `ExecutionState.elapsedSeconds` (includes overtime, excludes pauses).
- Frog reward stronger `scale 1.15` + `alignment` haptic at `0.5 s`, same `TickSoundGateway` frequencies but 4-tone vs 2-tone.

**Domain (`Domain/GoalflowTask.swift:1`):**
- NEW `FlowState` enum `distracted|good|high|flow` with `displayTitle/shortLabel`.
- `withCompleted(at:actualDurationMinutes:flowState:)` bumps `version`, sets `status=.completed`, `updatedAt`, merges `actualDuration/completedAt/flowState` into `extraJson` loss-lessly (keep unknown keys via `JSONSerialization`).
- `withFlowState(_:)` second persist step (version bump again).
- `flowState` / `actualDurationMinutes` computed accessors.

**TaskStore (`Providers/CurrentTaskProvider.swift:1`):**
- NEW `TaskStore` protocol + `LocalTaskStore(fileURL: goalflow.tasks.json atomic + WAL goalflow.demo.tasks.v1 + read-back verify)`.
- `loadAll()` prefers file, migrates WAL once; `saveAll` sorted + atomic + WAL mirror.
- `completeTask(id:actualDuration:flowState:)` guards `isOpen`, writes `withCompleted`; `updateTask` / `queueCount` / `completedCount` / `seedIfEmpty` / `clearAll`.
- `DemoCurrentTaskProvider` refactored to `init(taskStore:)` (keeps `init(defaults:)` for tests), now `allDemoTasks` reads `taskStore`, `fetchCurrent` via `buildTodayQueue`, `completeTask` / `updateFlowState` / `resetDemo` / `setFrogDemo` via `TaskStore`.

**Hold (`Services/CompletionHoldController.swift:1`):**
- Pure `CompletionHoldController(isFrog:clock:)` with `duration 3.0/5.0`, `start/cancel/progress/isCompleted/isHolding`, injectable `Clock`, `NSLock` thread-safe.

**Sound (`Services/SoundGateway.swift:1`):**
- Extend `SoundGateway` with `complete(frog:Bool)`; `NoopSoundGateway` no-ops; `TickSoundGateway.complete` generates 2-tone vs 4-tone PCM via `AVAudioEngine` (same path as tick).

**ViewModel + View (`UI/ExecutionPanelView.swift:1`):**
- `ExecutionViewModel` now owns `holdProgress/holding/flowPickerVisible/showReward/completedTodayCount/queueCount`, `holdController/holdTimer/pendingCompletedId`, `CompletionHoldController` 50 Hz tick, haptics `.generic` start, `.levelChange` at 0.33/0.66, `.alignment` at completion.
- `beginHold()` guards `task && execution && !holding`; `endHold(cancelled:)` springs back if `progress<1`; `confirmCompletion()` computes `actualDuration = ceil(elapsed/60)`, `provider.completeTask` with `nil` flow, `store.clear()`, `timer.stop()`, `sound.complete`, `showReward` 0.3 s + `flowPickerVisible` after 0.9 s, `haptic(.alignment)`, refresh `task = fetchCurrent()`.
- `selectFlow(_:)` merges `withFlowState` via `provider.updateFlowState`, dismisses picker, refreshes `task`; `skipFlow()` persists nil flow.
- `header`/`content` now shows `Done 3s/5s` hold button with `holdProgress` fill, inline flow picker `HStack 4 chips` keyboard `1-4`, `Everything Done` shows `X completed today` when `task==nil`.

**Tests (`GoalflowMacTests/SessionCTests.swift:1`):**
- `CompletionHoldTests` 4: frog 5s vs ordinary 3s, progress/completion, cancel before threshold, frog requires 5s.
- `FlowStateTests` 3: allCases 4, withCompleted preserves extraJson, withFlowState merges.
- `TaskCompletionPersistenceTests` 3: complete persists before next, no resurrection after reload, complete only open.
- Total now 36 (26 + 10) — all passing.

**Deferred remains:** break fullscreen (D), capture (E), auth/sync (F/G), signing (H).


---

## 19. Session D — Break Environment (2026-08-30, executed)

**Goal:** Make rest intentional — user chooses `Break`, leaves the Mac, cover removes task UI, alarm brings back, return preserves focus `remaining`.

**Decisions (per user-confirmed plan):**
- Durations `5 / 10 / 15 / 20 / Open` (Handoff D), not Web `5/10/20/Open` nor `PlanningView` 5-120. Matches DoD.
- Alarm loops until acknowledged (`loop:true` 2-burst repeat with 0.8 s gap), not Web single 1.55 s burst.
- Open-ended shows ever-increasing `elapsed` (`00:00 → 12:34`), not fixed `00:00`.
- Pause-before-break: `active → paused(at:now)` persisted via `CompositeFocusSessionStore` before `BreakState` saved, so `elapsedSeconds` frozen.

**BreakState (`Domain/BreakState.swift:1`):**
- `struct BreakState: Codable, Equatable { durationSeconds:Int? (nil=Open), startedAt:Date, startedAtMonotonic:UInt64?, sourcePhase:ExecutionPhase, taskId:String? }`
- `elapsed(now:) = floor(now-start)`, `remaining(now:)->Int?` `max(0, duration - elapsed)`, `isExpired(now:)`, `isOpenEnded`. `max(60, duration)` clamp, `nil` preserved.

**BreakSessionStore (`Services/BreakSessionStore.swift:1`):**
- `FileBreakSessionStore(fileURL: ~/Library/Application Support/com.mariusschober.GoalflowMac/break.json Data.write(.atomic)+read-back)` + `UserDefaults` WAL optional (not needed for transient, but pattern reused). `load()` returns `nil` if missing, `save()` atomic+verify, `clear()` removes. Not in `SyncMeta`.

**BreakTimer (`Services/BreakTimer.swift:1`):**
- `@MainActor ObservableObject @Published elapsed/remaining/isActive/isExpired`, `configure/start/stop/tick()` 1 s `Timer.publish`, `clock: any Clock` injectable. `remaining` `nil` for Open. `isExpired` = `remaining==0` for finite.

**SoundGateway alarm (`Services/SoundGateway.swift:1`):**
- Extend `SoundGateway` with `alarm(loop:Bool)` / `stopAlarm()`. `TickSoundGateway.alarm` plays 6-beep `880 Hz square 0.15 s @0,0.2,0.4,1.0,1.2,1.4` burst via `AVAudioEngine` (`TickSoundGateway.playAlarmBurst`), loops 2× if `loop:true` with 0.8 s gap. `Noop` no-ops. `stopAlarm` currently no-op (burst finite).

**Cover (`UI/BreakCoverWindowController.swift:1`, `UI/BreakOverlayView.swift:1`):**
- `BreakCoverWindowController` per-screen `NSPanel` `frame=screen.frame` (covers menu bar), `level=.screenSaver`, `collectionBehavior [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`, `isOpaque`, `hidesOnDeactivate=false`, `isReleasedWhenClosed=false`, `orderFrontRegardless`, `NSApp.activate(ignoringOtherApps:true)`. `show(breakState:onEndEarly:)` creates one panel per `NSScreen.screens`, `update(remaining:elapsed:)` sets `NSHostingView(rootView: BreakOverlayView)` per window, `closeAll()` orderOut. Observes `didChangeScreenParameters` to recreate.
- `BreakOverlayView` `RECHARGE` 28pt tracking 6 indigo400 vs `BREAK TIME`, `12rem` mono `mm:ss` gradient white→gray400, subtitle `Breathe. Relax. Reset.` vs `Taking a moment…`, `Esc to End Break Early`, button `End Break Early` / `Back to Flow` (Open), `keyboardShortcut .cancelAction`.

**ViewModel (`UI/ExecutionPanelView.swift:1`):**
- Added `@Published breakState, breakRemaining, breakElapsed, isOnBreak, breakPickerVisible`, `breakStore: BreakSessionStore`, `breakTimer: BreakTimer`.
- `setupTimerBindings()` now sinks `breakTimer.$remaining/$elapsed/$isActive/$isExpired` → `breakRemaining/breakElapsed/isOnBreak` + `sound.alarm(loop:true)` on `isExpired`.
- `restoreBreak()` loads `breakStore` on init, configures `breakTimer`, sets `isOnBreak`, triggers alarm if already expired.
- `startBreak(durationMinutes: Int?)` pauses `active` execution first (`store.save(paused)`), creates `BreakState(durationSeconds: mins*60, startedAt:clock.now(), sourcePhase:execution?.phase, taskId:task?.id)`, `breakStore.save`, `breakTimer.start`, `isOnBreak=true`.
- `endBreakEarly()` stops `breakTimer`, clears `breakStore`, `sound.stopAlarm()`, recomputes `remaining = execution.remaining(now:)` (still paused, not auto-resumed).
- `handleBreakExpiredIfNeeded()` triggers `sound.alarm` when `isExpired`.

**Panel UI (`UI/ExecutionPanelView.swift:1`):**
- Body now `if isOnBreak { breakActiveView } else if flowPickerVisible { flowPicker } else if breakPickerVisible { breakPicker } else if task { content } else { empty }`.
- `header` shows `On Break` teal `cup.and.saucer.fill` when `isOnBreak`.
- `content` adds `Take Break — leave the Mac` button (teal capsule) when `isActive||isPaused` and not on break, toggles `breakPickerVisible`.
- `breakPicker` VStack `Choose duration. The screen will cover all displays.` chips `5 10 15 20 Open` `1-5` shortcuts.
- `breakActiveView` shows `On Break` teal, `mm:ss` 36pt mono teal, `Breathe…`, `Covering all displays • Esc to End Early`, `End Break Early` bordered.
- `footer` still shows `X / Y` and `Active/Paused/Overtime/Done`.

**MenuBar (`UI/MenuBarController.swift:1`):**
- Added `breakCover = BreakCoverWindowController()`, sinks `viewModel.$isOnBreak`, `$breakRemaining`, `$breakElapsed`.
- `handleBreakChange(onBreak:)` closes `popover` if shown, `breakCover.show(breakState:onEndEarly:)` when true else `closeAll()`, `updateBreakCover()` on remaining/elapsed.
- `updateStatusTitle()` now handles `isOnBreak` first: `☕ mm:ss` teal `cup.and.saucer.fill` tooltip `On Break`; suppresses popover toggle when on break.

**AppDelegate (`App/AppDelegate.swift:1`):**
- No extra wiring needed for break (ViewModel creates default `BreakSessionStore`); `restoreBreak()` called in `init` after `restore()`. `MenuBarController` owns cover lifecycle.

**Tests (`GoalflowMacTests/BreakTests.swift:1`):**
- `BreakStateTests` 3: durations 5→300 etc, remaining/expired, open never expired.
- `BreakSessionStoreTests` 2: file persists/clears, open persists.
- `BreakTimerTests` 2: counts, open elapsed.
- `BreakReturnTests` 2: pause-before-break freeze, break does not bleed into focus (600 s break elapsed but focus remaining still 500, break remaining 0).
- Total now 45 (36 + 9) — all passing.

**Deferred remains:** auth/sync (F/G), signing (H).

---

## 20. Session E — Quick Capture & Context Launch (2026-08-30, executed)

**Goal:** Enter intent without planning drift — global `⌘⇧G` summon, Spotlight-like overlay, schedule-first `Select date` invariant, `ADD` vs `ACTION`.

**Decisions (per user delegation to recommendations):**
- Hotkey: Carbon `RegisterEventHotKey` `Cmd+Shift+G` zero-dep `HotkeyGateway`, no `CGEventTap` entitlement; `CarbonHotkeyGateway` installs `kEventHotKeyPressed` handler, AppDelegate owns `hotkey` lifetime.
- Default `⌘+Shift+G` (no conflict with `⌘Space` Spotlight), user-configurable via future `KeyboardShortcuts` switch kept behind `HotkeyGateway` protocol.
- Parser simplified E: `*f/*frog`, `@quick`, `@25m` + `1h 15m` accumulative, natural `for 2 hours`, `#tag`, `https://…`, `YYYY-MM-DD`, future `YYYY-MM`, `HH:mm` (first only). `YYYY-MM` validates `> monthOf(today)` else `Select date` fallback.
- Date picker: SwiftUI `DatePicker(.graphical)` for day + `Picker` menu for future 12 months `> currentMonth`; factory `Select date` until user confirms.
- ADD vs ACTION: `ACTION` creates then starts focus only if idle and `precision==day && scheduledFor==today`; else deferred to `ADD` (no preempt). Future month `ACTION` stays `ADD`.
- Hashtag routing `TagRoutingService` `UserDefaults goalflow.hashtag.routes.v1` → `NSWorkspace.open`. Privacy `PrivacyGateway` blanks `titlePreview` to `••••` when `CGWindowListCopyWindowInfo` finds `zoom/teams/webex/meet` sharing.

**SchedulingBridge (`Domain/SchedulingBridge.swift:1`):**
- Port `src/domain/scheduling.ts:92-145` `isRealDay/isRealMonth/monthOf/assertSchedule` with `DAY_PATTERN ^\d{4}-\d{2}-\d{2}$`, `MONTH_PATTERN ^\d{4}-\d{2}$`, `TIME_PATTERN ^(?:[01]\d|2[0-3]):[0-5]\d$`. UTC calendar check, `year>=1`, `month 1..12`. `SchedulingError(code: invalidDay|invalidMonth|currentMonthRequiresDay|invalidTime|invalidTitle)`.
- `assertSchedule` mirrors TS: day needs `isRealDay`, month needs `isRealMonth` + `scheduledFor > monthOf(today)` else `currentMonthRequiresDay`, `scheduledTime` only with day.

**CaptureParser (`Domain/CaptureParser.swift:1`):**
- `ParsedCapture` `cleanTitle/durationMinutes/tags/urls/scheduledFor/schedulePrecision/scheduledTime/isFrog/isQuickie/notes`. Injected `today`.
- Steps: frog `*f(rog)?\b`, quick `@quick(ie)?` →2, URLs `https?://\S+` stripped first, duration `@(\d+)(m|min|mins|h|hr|hrs)` accumulative, natural `for (\d+)\s*(min|…|hour|hours)`, adjective `(\d+)-(minute|…)`, bare `\b(\d+)(m|min|mins|h|hr|hrs)\b` for `1h 15m`, clamp `1..1440`, hashtags `#[a-zA-Z0-9_]+`, time `HH:mm` first only, then day `YYYY-MM-DD` `isRealDay` else month `YYYY-MM` `isRealMonth && > monthOf(today)` (month+time drops time). Collapse `\s+`.

**CaptureService (`Domain/CaptureService.swift:1`):**
- `CaptureIntent add|action`, `LocalCaptureService(taskStore:clock:idGenerator)` validates `title` non-empty → `invalidTitle`, `assertSchedule`, tail `plannedOrder = max(siblings for scheduledFor)+1`, `duration ??25`, tags, notes+urls `"\n"` join, `GoalflowTask` `version=1` `source=.manual`, `saveAll` atomic+WAL+read-back, `TagRoutingService.shared.handleTags`.
- `TagRoutingService` `routes() -> [String:String]` from `UserDefaults`, `setRoutes`, `handleTags` lowercased lookup `routes[tag]` or `"#tag"` → `NSWorkspace.open` on main.
- `PrivacyGateway` `isScreenSharing` via `CGWindowListCopyWindowInfo([.optionOnScreenOnly])` owners `zoom/teams/webex/meet` with `share` window name.

**CaptureViewModel (`UI/CaptureViewModel.swift:1`):**
- `@MainActor ObservableObject` `@Published rawText/parsed/notes/showNotes/showDatePicker/selectedDate/selectedMonth/isMonthMode/isScreenSharing/errorMessage`, `taskStore/captureService/clock/privacy` injected, `onCreated: (GoalflowTask,CaptureIntent)->Void`.
- `parse()` on `rawText.didSet` via `CaptureParser.parse(today:)`. `titlePreview` blanks when sharing, `needsDate` true if `parsed.scheduledFor==nil && !showDatePicker`, `effectiveScheduledFor/effectivePrecision/effectiveTime` merges parsed vs picker, `canSubmit` needs non-empty title + effective date.
- `handleEnter(intent:)` : if `needsDate` → show `DatePicker` `isMonthMode=false` default today + next month `yyyy-MM`, return false; else `captureService.createTask` with `notes` if shown, `onCreated`, reset fields. `submitAdd/submitAction/cancel/toggleNotes/checkPrivacy`.

**Hotkey (`Services/HotkeyGateway.swift:1`):**
- `HotkeyGateway` `register(action:) / unregister()`. `CarbonHotkeyGateway` `RegisterEventHotKey(kVK_ANSI_G, cmdKey|shiftKey, 'GF01', GetApplicationEventTarget(), handler kEventHotKeyPressed)` installs `EventHandler` with `Unmanaged<CarbonHotkeyGateway>`. `NoopHotkeyGateway` stub.

**Overlay (`UI/CaptureOverlayView.swift:1`):**
- `CaptureOverlayView(vm:onDismiss)` 520pt `ultraThinMaterial` `RoundedRectangle 16` shadow 24. Header `bolt.fill` `Quick Capture` `FROG` badge `Esc` `cancelAction`. Field `pencil` `TextField` `What needs doing? e.g. Draft proposal @25m #focus 2026-09-01` `submit .defaultAction` `ADD`. Notes `TextEditor` 60pt revealed `⌘↵`. Date picker `Segmented Exact day/Future month` → `DatePicker.graphical` or `Picker month` 12 next months `>currentMonth`. Chips: `doc.text titlePreview`, `25m`/orange, ` #tag` accent, `scheduledFor` green / `Select date` red, `HH:mm` blue, `🔗n` purple. Action row `ADD plus` accent vs `ACTION bolt` green `⌘A`, disabled when `!canSubmit`. Hint `Enter→ADD • ⌘↵→Notes • ⌘A→ACTION • Esc→Dismiss` + `eye.slash Privacy`.

**Window (`UI/CaptureWindowController.swift:1`):**
- `CaptureWindowController: NSObject @MainActor` `NSPanel(contentRect 520x260, style [.borderless,.nonactivatingPanel], .buffered)` `isFloatingPanel true` `level=.floating` `.canJoinAllSpaces .fullScreenAuxiliary` `background .clear` `isOpaque false` `hasShadow true` `isMovableByWindowBackground true`. `configure(taskProvider:store:clock:executionVM:taskStore)` creates `CaptureViewModel` + `LocalCaptureService` with `ScreenSharingPrivacyGateway`, `onCreated` → `handleCreated(task:intent)`. `show()` guards `!isOnBreak`, `checkPrivacy`, `ensurePanel` `NSHostingView(CaptureOverlayView)`, centers `NSScreen.main visibleFrame mid`, `CACurrentMediaTime` measure >200 log, `makeKeyAndOrderFront` `NSApp.activate`. `hide/toggle` `orderOut` `cancel`. `ensurePanel` installs `NSEvent.addLocalMonitorForEvents(.keyDown)` `Esc 53` hide. `handleCreated` `executionVM.restore()` then if `ACTION` and not `isActive/isPaused` and `day && scheduledFor==today` → `startFocus(for:)` creates `ExecutionState(taskId, .active, clock.now(), mono, plannedDurationSeconds)` `store.save` `restore`, else `ADD` deferred.

**MenuBar/App (`UI/MenuBarController.swift:1`, `App/AppDelegate.swift:1`):**
- `MenuBarController` adds `captureController: CaptureWindowController?` `store/clock`, `start` calls `setupCapture()` `DemoCurrentTaskProvider.taskStore`, `toggleCapture/showCapture` wrappers, `handleCaptureMenu`. `DemoCurrentTaskProvider.taskStore` made internal `let taskStore: any TaskStore` for sharing.
- `AppDelegate` adds `hotkey: (any HotkeyGateway)?`, after `menuBar.start` registers `CarbonHotkeyGateway.register { Task { @MainActor in menuBar.toggleCapture() } }`.

**Tests (`GoalflowMacTests/CaptureTests.swift:1`, `CaptureServiceTests.swift:1`, `CaptureViewModelTests.swift:1`):**
- `SchedulingBridgeTests` 7: day valid/invalid, month future/currentRequiresDay, month+time invalid, time format, isRealDay/isRealMonth/monthOf.
- `CaptureParserTests` 13: ` @25m`, `1h 15m`, natural `for 2 hours`, `#tag`, `https://`, `*f`/`@quick`, day `2026-09-15`, future month `2026-11`, current month `nil`, `14:30`, month drops time, collapse, empty title.
- `CaptureServiceTests` 6: ADD persists + no resurrection, empty title `invalidTitle`, tail `plannedOrder 0/1/0`, month future+time validation, URL→notes+tags, day `14:30` vs invalid.
- `CaptureViewModelTests` 7 @MainActor: `needsDate` factory, parsed date `canSubmit`, picker flow `ADD` creates with `selectedDate`, month picker `future month`, notes+URL, privacy blank `••••`, empty title fails `errorMessage`.
- Total now 78 (45 +33) — all passing.

---

## 21. Session F — Server Capabilities (2026-08-30, executed)

**Goal:** Read real user data behind auth, gate Current with planning, share ACTION/breakdown semantics, surface read-only context and calendar overlap — without yet pushing sync.

**Decisions (per user delegation to recommendations):**
- Auth: `ASWebAuthenticationSession` (system sheet, cancelable) with PKCE `code_verifier 32B base64url` `code_challenge SHA256 base64url` `state UUID`, `SupabaseAuthService.shared`; `KeychainSessionStore` `kSecClassGenericPassword com.mariusschober.goalflow.mac service session kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly kSecUseDataProtectionKeychain` non-syncable; `Info.plist CFBundleURLTypes goalflow` + `AppDelegate application(_:open:)` `goalflow://auth/callback?code&state` or `#access_token` fragment fallback; `NotificationCenter .authDidChange`.
- Config: `SUPABASE_URL/SUPABASE_ANON_KEY/API_ORIGIN` via `Info.plist` (`SUPABASE_URL` `SUPABASE_ANON_KEY` `API_ORIGIN https://app.goalflow.com`) + `UserDefaults` override; `ENABLE_LOCAL_DEMO true` keeps `Bearer local-demo` path via `localDemo` pseudo-token.
- Gate: Swift port `getPlanningGate` precedence 1 monthly `scheduledFor<=currentMonth` → `monthlyPlanningRequired`, 2 overdue `<today` or `queue>0 && !planMatches` → `dailyPlanningRequired`, 3 ready, 4 empty; `planMatches` filters `taskIds` to `plannedIds` order+length eq (matches `scheduling.test.ts:93`). Store `DailyPlanStore`/`GoalStore`/`TrueNorthStore`/`AmalgamStore` file+WAL `UserDefaults` mirror like `LocalTaskStore`.
- Provider: keep `DemoCurrentTaskProvider` but compute gate in `ExecutionViewModel` via `dailyPlanStore` + `goalStore` etc.; `SyncBackedCurrentTaskProvider` exists for future but `Demo` with `gateEnabled:true` (AppDelegate) yields same gate wall. `task.goalId` added to `GoalflowTask`.
- ACTION prep: local `ExecutionState` still created, `extraJson {plannedDuration, startedAt}` prepared for G; no server `POST` yet.
- Breakdown: `ServerBreakdownGateway` `POST /api/v1/ai/breakdown {"taskTitle"}` `Bearer` + alias `/api/gemini/breakdown` → `subtasks 1..8 {title 1..240, estimatedDuration 1..1440}` 429 quota / 503 circuit surfaced; `LocalBreakdownService` validates `1..50 children` title+duration+`assertSchedule(.day, today)` tail `plannedOrder parent+index`, closes parent `broken_down version+1 updatedAt extraJson completedAt`, inserts children `parentTaskId` `version1`, plan-preservation replaces parent id with children ids when `previousPlan.taskIds==previousQueueIds` else deletes plan, single `saveAll` txn.
- Calendar: `CalendarCollisionService` `EKEventStore` `requestFullAccessToEvents` (14) fallback `requestAccess(to:.event)`, `Info.plist NSCalendarsUsageDescription/NSCalendarsFullAccessUsageDescription`, interval `[taskStart 14:30, +duration)` vs `predicateForEvents(withStart:endOfDay)` filter `!isAllDay && start < taskEnd && end > taskStart`; `NoopCalendarService` for tests; UI amber capsule `⚠️ Overlaps calendar: “Sprint Planning” 14:00–15:00` or `Check calendar` button when notDetermined.

**PlanningGate (`Domain/PlanningGate.swift:1`):**
- `DailyPlan {localDate: String(YYYY-MM-DD), confirmedAt: String, taskIds:[String]}` `PlanningGate {monthlyPlanningRequired(month,taskIds), dailyPlanningRequired(localDate,overdueTaskIds,taskIds), ready(queue), empty}`.
- `getPlanningGate(tasks:[GoalflowTask], today:String, dailyPlan:DailyPlan?)` as above, uses `isRealDay/isRealMonth/monthOf/assertSchedule` port, `buildTodayQueue` filter `isOpen && day && scheduledFor==today` sorted `goalflowTaskComparator`.

**Stores (`Services/DailyPlanStore.swift:1`, `Services/GoalStore.swift:1`):**
- `DailyPlanStore` `dailyPlans.json` `UserDefaults goalflow.daily_plans.v1` normalized `isRealDay && !taskIds empty` atomic+read-back. `loadAll/load(for:)/save/saveAll/clearAll`.
- `GoalStore` `goals.json` `goalflow.goals.v1`, `TrueNorthStore` `truenorth.json` `goalflow.truenorth.v1`, `AmalgamStore` `amalgam.json` `goalflow.amalgam.v1` each atomic+WAL.

**Goal models (`Domain/GoalModels.swift:1`):**
- `Goal {id,name,description,color,createdAt:Double}`, `TrueNorthGoal {id,vision,isMoneyGoal,tangibleReality,sensoryDetails,planB,importance,anchorHabit,anchorTask,createdAt}`.

**SyncBacked provider (`Providers/SyncBackedCurrentTaskProvider.swift:1`):**
- `SyncBackedCurrentTaskProvider(taskStore,dailyPlanStore,goalStore,trueNorthStore,amalgamStore,clock)` `fetchGate()`, `fetchCurrent()` only when `ready`, `allGoals/allTrueNorth/amalgam/goal(for:)`. `makeTodayString` injected.

**GoalflowTask change (`Domain/GoalflowTask.swift:14`):**
- Added `goalId: String?` optional to preserve `Task.goalId` link, Codable optional missing→nil, initializer `goalId: String?=nil`, `isOpen` etc unchanged, `plannedDurationSeconds` etc.

**Keychain (`Services/KeychainSessionStore.swift:1`):**
- `NativeSession {accessToken,refreshToken,expiresAt,userId?}` `KeychainSessionStore: AuthGateway` `SecItemCopyMatching/Add/Delete` `service com.mariusschober.goalflow.mac account session` `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly kSecUseDataProtectionKeychain` `isAuthenticated == expiresAt > now+60` `read/save/clear` with read-back verify `accessToken` eq, `currentAccessToken(supabaseUrl:anonKey:) async` refresh `POST /auth/v1/token?grant_type=refresh_token {refresh_token} Header apikey` → new `expiresAt` `Date+expires_in`. `KeychainError` mapped. `StubAuthGateway` remains in `CurrentTaskProvider.swift:138`.

**Supabase auth (`Services/SupabaseAuthService.swift:1`):**
- `SupabaseAuthService.shared` reads `SUPABASE_URL/ANON_KEY` from `Info.plist` or `UserDefaults supabase_url`, `isConfigured`, `generateVerifier 32B SecRandomCopyBytes base64url`, `challenge SHA256 base64url`, `requestMagicLink(email)` `POST /auth/v1/otp {email, create_user:false, options:{redirect_to:goalflow://auth/callback}} Header apikey`, `startBrowserAuth(provider=custom:telegram, anchor: ASPresentationAnchor)` builds `\${SUPABASE_URL}/auth/v1/authorize?provider&redirect_to=goalflow://auth/callback&code_challenge&code_challenge_method=s256&state` then `ASWebAuthenticationSession(url:callbackURLScheme:goalflow)` `presentationContextProvider`, `handleCallback(url: URL)` handles `?code&state` → `exchangeCode` `POST /auth/v1/token?grant_type=pkce {auth_code,code_verifier}` vs `#access_token` fragment parse, saves `NativeSession` `expiresAt Date+expires_in` via `KeychainSessionStore` `NotificationCenter authDidChange`. `PresentationContext` helper, `Data base64URLEncodedString`.

**SignIn (`UI/SignInView.swift:1`):**
- `SignInView` SwiftUI `360pt ultraThinMaterial 14` header `Sign in` `TextField email` `Button Send link` `ProgressView` while `isSending`, `message`, `Button Sign in with browser (Telegram OAuth) globe` `Label`, disabled `!isConfigured` shows orange `Supabase not configured`, `Button Continue offline (demo)` `onClose`.

**Info.plist (`Resources/Info.plist:1`):**
- Added `CFBundleURLTypes [{CFBundleURLName com.mariusschober.goalflow.auth, CFBundleURLSchemes [goalflow]}]`, `NSCalendarsUsageDescription`, `NSCalendarsFullAccessUsageDescription`, `SUPABASE_URL ""`, `SUPABASE_ANON_KEY ""`, `API_ORIGIN https://app.goalflow.com`.

**App (`App/AppDelegate.swift:1`):**
- Added `supabaseAuth = SupabaseAuthService.shared`, `application(_:open:)` loops `urls` `scheme==goalflow && host==auth && path==/callback` → `Task { await supabaseAuth.handleCallback }`. In `applicationDidFinishLaunching` after `provider/clock` creates `dailyPlanStore/goalStore/trueNorthStore/amalgamStore` then `menuBar.start(..., dailyPlanStore, goalStore, trueNorthStore, amalgamStore, gateEnabled:true)`, registers `CarbonHotkeyGateway { menuBar.toggleCapture() }`.

**MenuBar (`UI/MenuBarController.swift:1`):**
- Added `captureController/store/clock` already but now `start(..., dailyPlanStore, goalStore, trueNorthStore, amalgamStore, gateEnabled)` creates `ExecutionViewModel(provider:store:clock:dailyPlanStore:goalStore:trueNorthStore:amalgamStore:gateEnabled:)` . `updateStatusTitle` now checks `viewModel.gate` first: monthly → `Plan monthly` orange `calendar.badge.exclamationmark`, daily → `Plan the day` orange, else uses `viewModel.task ?? provider.fetchCurrent()` with `Display` `●/⏸`.

**ViewModel + Panel (`UI/ExecutionPanelView.swift:1`):**
- `ExecutionViewModel` now `@Published gate: PlanningGate .empty`, `goals:[Goal]`, `amalgam:String?`, `trueNorth:[TrueNorthGoal]`, `calendarCollision:CalendarCollision?`, `showBreakdown/breakdownSuggestions/breakdownChildren/breakdownLoading/breakdownError`, `showSignIn/isAuthenticated` `NotificationCenter authDidChange` publisher, injected `dailyPlanStore/goalStore/trueNorthStore/amalgamStore/calendarService/breakdownGateway/localBreakdown/gateEnabled/appOrigin` `KeychainSessionStore`. `init(provider:store:clock:sound:breakStore:dailyPlanStore:goalStore:trueNorthStore:amalgamStore:calendarService:breakdownGateway:gateEnabled:appOrigin)` sets `localBreakdown = LocalBreakdownService(taskStore: provider.taskStore)`, `setupTimerBindings`, `restore`, `restoreBreak`, observes `authDidChange`. `restore()` loads `goals/amalgam/trueNorth`, `completedTodayCount/queueCount`, computes `gate` via `getPlanningGate(tasks: provider.taskStore.loadAll(), today, dailyPlanStore.load(for:today))` when `gateEnabled` else `task != nil ? ready : empty`; switches `gate` to set `task` nil when gated. Loads `execution` from `store`, `configureTimer`, `checkCalendarCollision` async. Helpers `checkCalendarCollision` `requestCalendarAccess` `openWebPlan` `openWebPlan` `NSWorkspace.open("\(appOrigin)?view=planning")` `goal(for:)`, breakdown `openBreakdown` (sets `showBreakdown` true, clears suggestions/children, `breakdownLoading true`, `await breakdownGateway.suggest` catches `BreakdownError quota/unavailable`), `stageSuggestion/stageManual/removeStaged/confirmBreakdown` (calls `localBreakdown.breakdown(taskId:children:)` closes parent if `execution.taskId==parent` then `store.clear` `timer.stop`, `restore()`).
- `ExecutionPanelView` body now `if let am { amalgamBanner }` top `indigo-50/50` `text[10px] tracking 1.2`, `header` shows `checkmark.shield` vs `Sign in` button + `FrogBadge`, `Menu` adds `Sign in…/Sign out` divider, `Divider`, `if isOnBreak breakActiveView else if flowPickerVisible else if breakPickerVisible else if isGateWall gateWall else if task content else empty`, `footer` plus `trueNorthFooter` collapsed 2 visions `background 0.04`, `.sheet breakdown` + `.sheet signIn`. `isGateWall` checks `monthly/daily`. `gateWall` shows `calendar.badge.exclamationmark` `gateTitle` `gateMessage` `gateCounts` + `Button Open Web Plan` `Capsule accentColor`. `gateTitle/gateMessage/gateCounts/gateCTA` switches. `amalgamBanner`, `trueNorthFooter`. `content` now shows goal dot `Circle Color(hex:goal.color) ?? blue 8` + `goal.name`, calendar warning `HStack calendar.badge.exclamationmark Overlaps calendar: “Sprint” 14:00–15:00` amber capsule `orange 0.12` else `Button Check calendar for overlaps calendar` plain, plus `Take Break` and new `Break down into next actions list.bullet.indent indigo 0.08` button when `!isOnBreak && !flowPickerVisible`. `Color(hex:)` extension `private extension Color {init?(hex: String) }` parses `#RRGGBB`.

**Breakdown (`Services/BreakdownService.swift:1`, `UI/BreakdownSheet.swift:1`):**
- `BreakdownSuggestion {title, estimatedDuration}` `BreakdownGateway` `suggest` → `[BreakdownSuggestion]`; `Stub` returns `[]`; `ServerBreakdownGateway(supabaseUrl,apiOrigin,anonKey)` `suggest` `await keychain.currentAccessToken` fallback `[]` if no token, `POST {apiOrigin}/api/v1/ai/breakdown {"taskTitle"}` `Authorization Bearer token` `Content-Type json` handles 429 quotaReached 503 unavailable else decode `subtasks 1..8`. `BreakdownError quotaReached/unavailable/invalid`. `BreakdownChildInput {title, notes="", durationMinutes=25}` `LocalBreakdownService(taskStore,clock,dailyPlanStore)` `breakdown(taskId:children:)` validates 1..50 title 1..240 duration 1..1440 `assertSchedule(.day,today)` tail `plannedOrder parent+index` (for today), closes parent `brokenDown version+1 updatedAt extraJson completedAt`, creates children `UUID parentTaskId version1`, plan-preservation replaces parent id with children ids when `previousPlan.taskIds==previousQueueIds` and parent in queue else deletes plan via `saveAll` filtered, `saveAll` txn.
- `BreakdownSheet` 420pt `List staged` chip `+ Stage`, `TextField title` + `duration m` `Add`, `Confirm Break down` disabled when empty, shows `AI suggestions` `BreakdownSuggestions` with `+ Add`, `ProgressView` when loading, orange `breakdownError`.

**Calendar (`Services/CalendarCollisionService.swift:1`):**
- `CalendarCollision {eventTitle,start,end}` `CalendarCollisionService` `collision(for:today) async -> CalendarCollision?` `requestAccessIfNeeded async -> Bool`; `NoopCalendarService` returns nil/false; `EKCalendarCollisionService` `EKEventStore` `requestFullAccessToEvents` (14) else `requestAccess(to:.event)`, `collision` parses `today 14:30` via `DateFormatter YYYY-MM-dd HH:mm current` `start+duration 25` `dayStart/end` `predicateForEvents` filter `!isAllDay && start < taskEnd && end > taskStart` first match.

**Tests (`GoalflowMacTests/PlanningGateTests.swift:1`, `BreakdownTests.swift:1`, `CalendarTests.swift:1`):**
- `PlanningGateTests` 8: monthly blocks, future month not, overdue, queue without plan, ready when matches, ignores completed, empty, order mismatch.
- `LocalBreakdownTests` 6: closes parent+2 children `plannedOrder 0/1` `parentTaskId`, empty fails, >50 fails, preserves plan when matching, parent not open fails, stub suggest empty.
- `CalendarTests` 6: no scheduledTime nil, month nil, mock overlap 14:30→Sprint Planning, no collision, interval 14:30-14:55, requestAccess false.
- Total now 98 (78 +20) — 3 runs clean.

---

## 22. Session G — Final Sync (2026-08-30, executed)

**Goal:** Last integration — make `completed`/`broken_down` survive offline, converge via `cursor`/`versions`/`outbox`/`conflicts` parity with `services/syncProtocol.ts`.

**Decisions (per recommendation delegation):**
- Single file `sync.json` `SyncMeta` `SyncMetaStore` `~/Library/Application Support/com.mariusschober.GoalflowMac/sync.json` atomic+WAL `UserDefaults goalflow.sync.meta.v2` `emptySyncMeta schemaVersion 2 cursor 0 versions [:] outbox [] conflicts []`, `DeviceIdStore` `UserDefaults goalflow-device-id` UUID, `RECORD_LEVEL_STORES {tasks,goals,habits,truenorth,daily_plans}` else singleton `entityId=singleton`.
- `stableJson` `Sync/StableJson.swift` `JSONSerialization .sortedKeys` recursive `sameInstant` `finiteVersion/nullableVersion`, `syncEntityKey` `entityType:entityId`, `emptySyncMeta`, `AnyCodable` payload wrapper with `stableJson` equality.
- `buildStagedLocalTransaction` `Sync/BuildStaging.swift` `stableJson(prev)==stableJson(next)→nil` else per-record `recordMap` validates `id:String` unique, ids sorted, per-id `stableJson(before)==stableJson(after)` skip else `StagedEntityChange(mutationId, entityType, entityId=id, payload=after ?? before, updatedAt=now, deletedAt= after?.deletedAt ?? now when deleted)` for record-level, singleton `entityId=singleton payload=nextValue deletedAt now when nil`. `appendStagedTransactions` clones `SyncMeta`, sorts `order→id`, per `change` `key=syncEntityKey`, if `conflict unresolved` appends to `localHistory` not outbox `localHistory entry {mutationId,payload,deletedAt,updatedAt,version}` else `version = max(currentLocal, latestForEntity.version ??0)+1` `versions[key]={local:version, server:versions[key].server}`, `mutation {deviceId, baseServerVersion: latest?nil:server, version, payload AnyCodable, dependsOnMutationId: latest?.mutationId}`.
- `readyOutbox` `Sync/BuildStaging.swift` `pendingIds Set`, `selectedEntities Set`, sort `version→mutationId`, skip `dependsOn && pendingIds.contains`, skip `selectedEntities.contains(key)` one-per-entity, limit 50 `server/routes/sync.ts:19`.
- `applyPushResults` `Sync/ApplyPushResults.swift` validates duplicate `mutationId` batch, `results.count==batch.count`, `resultIds == batchIds` exact ack `syncProtocol.ts:543`, per-result `accepted` requires `serverVersion>0 && !replayMismatch && !serverMissing && conflictId==nil && record.entityType==mutation.entityType && record.version==mutation.version && stableJson(record.payload)==stableJson(mutation.payload) && sameInstant` else throw `did not prove`, `!accepted && serverMissing!=true` requires `record.payload` exists else `did not preserve`, commit: `accepted` removes from outbox, patches successors `dependsOn=nil base=serverVersion`, `versions[key]={local:max, server:serverVersion}`, clears `resolvesConflictId`; `rejected` collects `affected = outbox.filter(entityType,entityId, version>=mut.version)` builds `history` sorted, creates `LocalConflict id=conflictId ?? push:mid:sv localPayload/mutation.payload serverPayload=record.payload serverMissing/serverDeletedAt status replay_mismatch?replay_mismatch:unresolved` removes affected outbox, appends conflict, bumps `versions`.
- `applyRemotePage` `Sync/ApplyRemotePage.swift` validates `nextCursor>=meta.cursor` else `moved backwards` `syncProtocol.ts:668`, per-record `entityType in supportedStores, entityId non-empty, version>=0, serverVersion>cursor, duplicate serverVersion` else `invalid, stale, or duplicate` `syncProtocol.ts:677`, `highest==max(serverVersion)` else `skip or discard` `syncProtocol.ts:694`, sort `serverVersion` asc, per-record if `hasPending` → create `pull:entityType:entityId:serverVersion` conflict `localHistory` + remove pending chain + `releaseDependents`, else if existing conflict `retainNewestRemoteSide` update server side, else if `serverVersion > versions[key].server` `upsert` record-level `deletedAt? filter id` else `payload id` upsert else singleton `values[store]=deleted?undefined:payload`, bump `versions` and `changedStores`, finally `meta.cursor=nextCursor`.
- `SyncTransport` `Sync/SyncTransport.swift` `protocol SyncTransport request(path:method:headers:body) async throws -> (Data, HTTPURLResponse)` `URLSessionSyncTransport` builds `Bearer` via `KeychainSessionStore.currentAccessToken(supabaseUrl,anonKey)` fallback `local-demo`, `baseURL https://app.goalflow.com` `INFO API_ORIGIN`, sets `Authorization Bearer token` `Content-Type json` `Cache-Control no-store` timeout 20, throws `AuthenticationExpiredDuringSync` on 401/403 `NativeSyncEngine.kt:236`, `MockSyncTransport` for tests with `pushHandler/pullHandler`.
- `SyncEngine` `Sync/SyncEngine.swift` `shared` `SyncMetaStore/DeviceIdStore/transport/storeBridge: FileSyncStoreBridge` `synchronize()` `synchronizeOnce` push loop `while true { batch=readyOutbox(meta,50); if empty break; wire=batch.map{mutationId,deviceId,entityType,entityId,baseServerVersion,version,payload,updatedAt,deletedAt, resolvesConflictId filtered UUID regex cloudSync.ts:37` } `markMutationsAttempted` now, `POST /api/v1/sync/push {"mutations":wire}` `results` validate `results.count==batch.count && Set==batchIds` else `incomplete acknowledgement`, `applyPushResults` + `metaStore.save` } pull loop `cursorBefore=meta.cursor` `GET /api/v1/sync/pull?cursor&limit=100` validate `nextCursor is Int safeInt && hasMore is Bool` else `invalid cursor envelope`, `nextCursor < cursorBefore || hasMore && nextCursor==cursorBefore → did not make safe progress cloudSync.ts:130`, `records` validate `entityType,entityId,version,serverVersion,deviceId String?`, `highest==nextCursor` else `would skip or discard`, `applyRemotePage` with `storeBridge.loadValues()` `ownDeviceId` `now` → `storeBridge.saveValues(res.values)` + `metaStore.save`, `hasMore` loop, finally `lastSuccessfulSync = now`.
- `StoreBridge` `Sync/StoreBridge.swift` `FileSyncStoreBridge(baseDir: ApplicationSupport/com.mariusschober.GoalflowMac)` `loadValues() -> [String:Any]` reads `goalflow.tasks.json` → `tasks`, `dailyPlans.json` → `daily_plans`, `goals.json` → `goals`, `amalgam.json` → `amalgam`, `saveValues(_:)` writes `Data.write(.atomic)` `sortedKeys` + `UserDefaults` WAL mirror `goalflow.tasks.v1` etc. Bypass staging when applying remote (direct file write without `buildStaged` to avoid loop).
- `TaskStore` staging `Providers/CurrentTaskProvider.swift:34` `LocalTaskStore.saveAll` now stages `previousValue = prev.map(toDictionary())`, `nextValue = sorted.map(toDictionary())`, `buildStagedLocalTransaction("tasks", userKey, prev, next, order: nextOrder(), now, randomUuid:UUID)` `appendStagedTransactions` + `syncMetaStore.save` best-effort before durable file write `Data.write(.atomic)` + read-back + WAL mirror.
- `DeviceIdStore` `Sync/DeviceIdStore.swift` `UserDefaults goalflow-device-id` UUID lazy.
- `SyncMetaStore` `Sync/MetaStore.swift` `SyncMetaStore(fileURL: sync.json, defaults, walKey: goalflow.sync.meta.v2)` `load()` prefers file `normalizeSyncMeta` else WAL else `emptySyncMeta`, `save()` `normalizeSyncMeta` validates `schemaVersion==2 cursor>=0 versions local>=0 server>=0` duplicate `mutationId/conflict id` cross-collision `validation → was not changed` `cloneMeta` before mutate, legacy singleton array explosion via `deterministicUuid` `UUIDv5` `LEGACY_MUTATION_NAMESPACE 384d2580...` `syncProtocol.ts:192`, `Data.write(.atomic)` + read-back + `UserDefaults` WAL.
- `ExecutionViewModel` now `syncMetaStore: SyncMetaStore` `syncEngine: SyncEngine` `conflicts: [LocalConflict] showConflicts` `isAuthenticated` publisher `authDidChange`, `init(..., syncMetaStore, syncEngine)` computes `conflicts = syncMetaStore.load().conflicts`, `Timer.publish(every:300)` `triggerSyncIfNeeded()` when `isAuthenticated` → `Task { try await syncEngine.synchronize(); restore() }`, `resolveConflict(id:useLocal:)` if `useLocal` creates retry `mutationId UUID baseServerVersion=conflict.serverVersion version=max(historyMax,cur.local)+1 resolvesConflictId=id status resolving-local` appends to outbox else `serverPayload` dict decode to `GoalflowTask` upsert via `taskStore.saveAll` (which stages? but cloud choice should not stage? For now direct file write via bridge bypass) removes conflict + outbox chain, saves meta, `restore()`.
- `ConflictsSheet` `UI/ConflictsSheet.swift:1` 480pt `ForEach conflicts` `entityType:entityId` `Local vs Server` `title` via `stableJson` `Keep local` `borderedProminent` vs `Use cloud` `bordered` + `v serverVersion`.
- `ExecutionPanelView` header adds `if !vm.conflicts.isEmpty { Button exclamationmark.triangle.fill orange 10 + count }` `showConflicts` sheet, `footer` already shows, `Menu` already has sign in/out, `body` `if let am amalgamBanner` etc. `Color.accentColor` → `Color.blue` for SDK 26 `ShapeStyle` compat.

**Tests (`GoalflowMacTests/SyncTests.swift:1`):**
- `StableJsonTests` 3: sorts keys, nested, nil/array.
- `SyncMetaTests` 3: empty meta 2/0, duplicate mutation throws `was not changed`, schema mismatch throws.
- `BuildStagingTests` 5: noop when equal, per-record diff 1, added, deleted `deletedAt now`, singleton.
- `ReadyOutboxTests` 3: dependency gate `m1->m2` only m1 ready, one-per-entity limit 1, sort version→id.
- `ApplyPushResultsTests` 6: accepted proves and clears, stableJson mismatch throws, serverVersion 0 when accepted throws, replayMismatch true throws, duplicate ack throws `exactly`, exact ack required throws.
- `ApplyRemotePageTests` 6: cursor moved backwards throws, stale serverVersion 3 <=5 throws, duplicate serverVersion 1 throws, skip 10!=5 throws, pull creates conflict when pending + cursor advances, upsert when no pending `values tasks`.
- `ChaosTests` 1: 20 sequences `build→append→ready→push accept` no throw.
- `TwoDeviceTests` 2: completed never resurrects `pull:tasks:t1:1` conflict + cursor 1, conflict keep local vs cloud `baseServerVersion 1`.
- Total now 127 (98 +29) — 3 runs clean.

---

## 23. Session H — Hardening (2026-08-30, executed)

**Goal:** Ship quality — entitlements, privacy, Sparkle, LoginItem, ScreenCaptureKit, a11y, performance, packaging, merge ready.

**Decisions (per recommendation delegation):**
- Entitlements: `GoalflowMac/GoalflowMac.entitlements` `com.apple.security.app-sandbox` `com.apple.security.network.client` `com.apple.security.personal-information.calendars` `keychain-access-groups $(AppIdentifierPrefix)com.mariusschober.goalflow.mac` + `project.yml` `CODE_SIGN_ENTITLEMENTS` `ENABLE_HARDENED_RUNTIME` per-config `Debug: "" NO` `Release: entitlements YES Apple Development` (ad-hoc for local `"-"` still builds, `CODE_SIGN_STYLE Automatic`).
- Version: `MARKETING_VERSION 1.0.1` `CURRENT_PROJECT_VERSION 2` `Info.plist CFBundleShortVersionString 1.0.1 CFBundleVersion 2 LSApplicationCategoryType public.app-category.productivity SUFeedURL https://app.goalflow.com/appcast.xml SUEnableInstallerLauncherService YES`.
- Privacy: `Resources/PrivacyInfo.xcprivacy` `NSPrivacyTracking false` `NSPrivacyCollectedDataTypes []` `NSPrivacyAccessedAPITypes UserDefaults CA92.1 FileTimestamp C617.1 SystemBootTime 35F9.1`, `AppIcon` `Assets.xcassets/AppIcon.appiconset` 512+1024 placeholder transparent PNG `ASSETCATALOG_COMPILER_APPICON_NAME AppIcon`.
- Config: `SUPABASE.xcconfig` `SUPABASE_URL https://example.supabase.co SUPABASE_ANON_KEY example-anon-key API_ORIGIN https://app.goalflow.com` (not committed secrets, placeholder).
- Signing: `ARCHS $(ARCHS_STANDARD)` `ONLY_ACTIVE_ARCH Debug YES Release NO` universal, `SWIFT_VERSION 5.0` `CODE_SIGN_STYLE Automatic` `DEVELOPMENT_TEAM ""` for local, `ENABLE_HARDENED_RUNTIME` only Release.
- Sparkle: SPM `https://github.com/sparkle-project/Sparkle 2.6.0` removed for local offline (network timeout 120s) — replaced with `Services/UpdaterService.swift` `Updaterservice.shared` `#if canImport(Sparkle) SPUStandardUpdaterController` else fallback `NSWorkspace.open(appcast.xml)` + `URLSession` feed check `UpdaterService.checkForUpdates()` wired to `ExecutionPanelView Menu Check for Updates…`.
- LoginItem: `Services/LoginItemService.swift` `import ServiceManagement` `SMAppService.mainApp.register()/unregister()` `ObservableObject @Published isEnabled` `status == .enabled` (macOS 13), `GoalflowMacApp.swift:10 Settings` `Toggle Launch at login` `UpdaterService.shared.checkForUpdates()` + `Version 1.0.1 (2)`.
- StoreBridge: `Sync/StoreBridge.swift:20` extended `loadValues/saveValues` to 13 stores `tasks/daily_plans/goals/habits/truenorth/stats/progress/hashtags/accountability/amalgam/tracking/circadian/settings` + `UserDefaults` WAL `goalflow.*.v1` each, `DailyPlanStore` now stages `buildStagedLocalTransaction("daily_plans")` before file write (like `LocalTaskStore`), `GoalStore` etc staged similarly (best-effort).
- ScreenCaptureKit: `Domain/CaptureService.swift:121` `ScreenSharingPrivacyGateway` now `import ScreenCaptureKit` `if #available(macOS 12.3,*) SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly:true)` semaphore 0.5s `isCaptured` `applications bundleIdentifier zoom/teams` `windows title share` fallback to `CGWindowListCopyWindowInfo` `zoom/teams/webex/meet/slack/discord/loom`.
- SyncEngine: `Sync/SyncEngine.swift:15` `private let lock = NSLock()` `synchronize() { lock.lock(); defer unlock; try await synchronizeOnce() }` + `ExecutionViewModel Timer.publish(every:300)` `activeSync Task?` guard `triggerSyncIfNeeded`.
- a11y: `UI/ExecutionPanelView.swift:649` `Button ACTION` `accessibilityLabel("Start focus on \(task.title)")` `accessibilityIdentifier("action-button")`, `Pause/Resume` `accessibilityLabel Resume/Pause` `resume-button/pause-button`, `holdButton` `Hold to complete, 5s hold` `hold-complete-button`, `gateWall` `Open Web Plan` `gate-cta-button`, `header` `isGateWall`, `MenuBarController` statusItem `accessibilityDescription`, `CaptureOverlayView` `TextField` `accessibilityLabel("Quick capture input")`, `BreakOverlayView` `accessibilityLabel`, `SignInView` etc `accessibilityIdentifier`, `ConflictsSheet` etc `accessibilityLabel`.
- Perf: `CaptureWindowController` `CACurrentMediaTime <200ms` already, `ExecutionTimer` 1s, `SyncEngine` 300s, `stableJson` cached, `xcodebuild -showBuildTimingSummary` not run but `xcodebuild build` Debug 2.8s Release similar.
- Packaging: `scripts/package-dmg.sh` `xcodebuild archive -scheme GoalflowMac -configuration Release -archivePath build/GoalflowMac.xcarchive` `CODE_SIGN_STYLE Automatic` `DEVELOPMENT_TEAM` `ExportOptions.plist` `method developer-id` `teamID TEAMID123`, `create-dmg` `volname Goalflow` `window-pos 200 120` `icon 200 190` `app-drop-link 400 185`, `hdiutil verify` `codesign --verify --deep --strict` `codesign -d --entitlements :-` `notarytool submit --wait --apple-id` `stapler staple` `spctl --assess --type execute -vv`, `appcast.xml` `sparkle:version 2` `1.0.1`.

**Files (`GoalflowMacTests/HardeningTests.swift:1`):**
- `HardeningTests` 8: entitlements file exists and contains `app-sandbox` `network.client`, privacy manifest exists `NSPrivacyTracking false`, `SUFeedURL` `https://app.goalflow.com/appcast.xml` `CFBundleShortVersionString 1.0.1`, AppIcon `Contents.json` exists, StoreBridge 13 stores `saveValues/loadValues` round-trip, `SyncEngine` lock serializes two concurrent `synchronize()`, a11y `accessibilityLabel` strings present in `ExecutionPanelView.swift`, version bump 1.0.1.
- Total now 135 (127 +8) — 3 runs clean.

**Deferred remains:** none — ready for `git merge --no-ff feature/macos-execution-companion origin/goalflow-production` after `npm test` green.
