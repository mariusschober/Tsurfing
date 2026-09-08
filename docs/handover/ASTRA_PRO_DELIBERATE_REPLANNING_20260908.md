# Astra Pro handover: deliberate planning and offline reconciliation

**Status: unfinished review checkpoint, not a release candidate.** Prepared 8 September 2026 at the user's request. Implementation is paused for this handover. Please help the implementing agent simplify and finish the synchronization/recovery design; do not treat passing local tests as acceptance.

## Exact repository, branches, and lineage

Repository: [mariusschober/Tsurfing](https://github.com/mariusschober/Tsurfing).

| Purpose | GitHub branch / immutable commit |
| --- | --- |
| This implementation | [feat/deliberate-replanning-20260908](https://github.com/mariusschober/Tsurfing/tree/feat/deliberate-replanning-20260908) |
| Exact code checkpoint reviewed by this document | [f624afe787d4fc65ed33fd2b9bce1d909f9ff8ee](https://github.com/mariusschober/Tsurfing/commit/f624afe787d4fc65ed33fd2b9bce1d909f9ff8ee) — WIP, 78 changed files, 7,580 insertions / 349 deletions |
| Feature's integration base | [4666dd4d0de4700c5f549708779cd31df5d712e4](https://github.com/mariusschober/Tsurfing/commit/4666dd4d0de4700c5f549708779cd31df5d712e4) |
| Current independent S2 work | [codex/s2-causal-counters-20260907](https://github.com/mariusschober/Tsurfing/tree/codex/s2-causal-counters-20260907), fetched tip [0a207b751e32345690d988c68cf6424ef44d5666](https://github.com/mariusschober/Tsurfing/commit/0a207b751e32345690d988c68cf6424ef44d5666) |
| S2 checkpoint originally integrated | [78e24a3e97b316c976a1e871d7aa8acd680ff200](https://github.com/mariusschober/Tsurfing/commit/78e24a3e97b316c976a1e871d7aa8acd680ff200) |
| Prior, separately completed Plan mode/density work | [fix/plan-modes-and-density-20260908](https://github.com/mariusschober/Tsurfing/tree/fix/plan-modes-and-density-20260908), [5ea00f893a3ac2a131ffc9c53a6440e25b12b42f](https://github.com/mariusschober/Tsurfing/commit/5ea00f893a3ac2a131ffc9c53a6440e25b12b42f) |
| Existing personal-beta branch | [codex/personal-beta-finalization-20260904](https://github.com/mariusschober/Tsurfing/tree/codex/personal-beta-finalization-20260904), also at `5ea00f8` when fetched |

**Critical integration finding:** this feature does not include eight newer S2 commits. Its base merges S2 `78e24a3` with Plan UI `5ea00f8`. The newer S2 work includes:

- `b37c0d2`: explicit dismissal of blocked reviews and rejected completions, retaining audit evidence.
- `2bf78de`: Android task-only completion admission using ordinary transport.
- `a58a923`: recovery listing/dismissal in SyncStatus.
- Supporting design/status commits through `0a207b7`.

Review those changes before inventing more recovery machinery. They overlap `services/storage.ts`, `services/syncProtocol.ts`, `services/causalCompletionCoordinator.ts`, Android `GoalflowRepository.kt`, and `GoalflowViewModel.kt`. The latest S2 report itself still declares S2 incomplete. Do not infer an accepted synchronization foundation.

Local implementation worktree: `/private/tmp/tsurfing-deliberate-replanning`.
Canonical checkout: `/Users/schober/Projects/TSurfing`, on the independent S2 branch at `0a207b7`, clean when checked. It has not been replaced or modified by this feature's implementation. The GitHub checkpoint contains the source; local paths and test logs are conveniences only.

## Original goal and approved product plan

Deliver a clearer Plan screen and deliberate, confirmed replanning on Web, Android, and macOS, plus a complete future-task browser on Web. The intended outcome is a usable, verified, cross-device feature, not just an attractive screen or a local policy model.

The complete approved requirements are preserved in [DELIBERATE_REPLANNING_ORIGINAL_PLAN_20260908.md](DELIBERATE_REPLANNING_ORIGINAL_PLAN_20260908.md). The decisive requirements are:

1. One heading, **“Plan today’s flow”**, with duration; retain mode and density controls. Focus navigation opens Current without starting/resetting/replacing the timer.
2. Unlimited visits to Plan without punishment. First daily confirmation is free and locks order. Existing confirmed plans migrate to three free replans, without historical visit charges.
3. Locked order prevents dragging, keyboard moves, and reordering prioritization; notes, duration, additions, completions, rescheduling, review, and circadian check-in remain available. Adding tasks preserves existing relative order within scheduling precedence.
4. Replan is a durable private draft. Draft ordering/ratings do not affect Current or another device. Cancel only discards draft changes. Navigating away preserves Resume/Discard. Old-day drafts never become today's plan silently.
5. Count a replan only when confirmation changes relative order of remaining tasks. Three changed confirmations are free; subsequent cost is Classic 50 XP, Gentle 25, Off 0, with the existing floor behavior. Display cost before editing and confirmation.
6. One idempotent confirm-order operation includes account/day, operation ID, baseline revision, proposed order, optional ratings, maximum accepted XP. Commit policy/order/debit atomically. Retries cannot charge twice. Durable history survives completion/plan clearing.
7. Offline confirmation applies provisionally. On conflict, retain both versions and let the user keep synced order or review/apply their proposal at the displayed cost. Preserve additions/completions; never revive completed tasks or rewrite attempted requests.
8. Server/shared write paths enforce the lock, including older clients. Roll out additive server compatibility, then clients, then enforcement. Validate staging before production promotion.
9. Horizon shows all tomorrow tasks plus three later tasks. Planned-task dialog/sheet has complete chronological list, incremental rendering, calendar, day selection/Add, month-only “No day assigned,” preserved position, nested form/focus/Escape behavior, both themes/mobile layouts.
10. Actual Web–Android–macOS convergence and isolation/resolution of the known hosted HTTP 429 failure are required before acceptance.

## What is implemented locally

### Web UI and policy

- Heading, state-dependent actions/costs, unlimited Plan review, locking, private drafts, cancellation/resume, stale-draft review, original-date saved-order dialog.
- Bounded Horizon and List/Calendar planned-task browser with exact-date task form integration, month-only grouping, incremental list, mobile layout, focus handling.
- Shared pure policy, provisional durable planning admission, immutable command bytes, authenticated confirm/day/review routes, strict responses, per-account/day state and backup validation.
- SQL atomic confirm operation, policy/history storage, compatibility enforcement controls, and complete review snapshot RPC. Enforcement is intended to remain disabled until rollout is verified.

### Android

- Policy model, Room planning account table and database version 10, durable drafts/pending commands, displayed-cost confirmation, shared write guards, sync endpoints, review choices, dated saved-order dialog.
- Backup schema 6, exact planning/completion proof preservation, account binding, and dependency validation for ordinary edits waiting behind reserved logical operations.
- Rebase of a rejected order followed by one or two causal completions, and ordinary task edits before/after a completion. Original admissions and member IDs stay unchanged; effective payloads and XP are derived from retained evidence.

### macOS

- Policy model, durable daily-policy storage, policy fetch/merge, and ordering write guards.
- The existing native Mac application opens its planner on Web; no separate native full Plan editor was introduced. **Do not equate this architectural choice with cross-client acceptance.** Current Mac/native behavior and latest S2 integration still require real-client checks.

## The problem that consumed the time

This stopped being a UI-only change when provisional planning met the existing causal completion protocol.

Example: offline plan A changes order/XP; the user saves notes, completes a task, then confirms plan B. Another device changes the authoritative order. Plan A is rejected on reconnect. Local tasks/progress now include later actions based on A's provisional state.

Replacing local rows with the server snapshot loses notes/completions. Sending the original whole-row successors can restore rejected ordering or stale XP. Rewriting completion admissions destroys their retained identity/evidence. Pretending the rejected plan was accepted invents receipts. The existing reservation/dependency checks correctly stop these shortcuts.

The current approach retains originals and computes reviewed derivatives:

- Web: `planningResolutions`, `planningEdits`, and a retained `planningRebase` graph alongside local sync evidence. Completion admissions are immutable. Legacy edit proofs retain the original mutation and predecessor, and bind back to the original WAL capture. Outbox IDs stay the same only for requests that have never been attempted.
- Android: analogous JSON proof graph in planning state and causal authority; original ordinary row requests and completion admissions retained. Room writes/receipt bookkeeping remain atomic.
- Completion XP replays the captured reward onto the synced balance using each client's existing reward calculation, rather than subtracting/adding arbitrary XP deltas across level boundaries.
- Web's latest work lets a user choice supersede an **unattempted same-day continuation** of the rejected plan. Original pending commands/projections remain archived; no server receipt is fabricated. “Review my order” reopens the latest proposal. Dependencies inherit the preceding retained edit/completion or genuine server snapshot.

**This approach is a candidate design, not an independently approved protocol.** Please challenge its complexity and its compatibility with the newer S2 recovery design.

## Precise unfinished work and uncertainties

1. **Integrate/review the eight newer S2 commits first.** We discovered the divergence while preparing this handover. No merge has been attempted. Native task-only completions and rejected-completion dismissal are particularly relevant.
2. **Android does not yet implement Web's same-day continuation supersession.** Android still refuses resolution when a later planning reservation owns the entity. Porting the Web approach is not automatically the right decision; review the design first.
3. **Cross-day pending chains are unresolved.** The current Web continuation logic is deliberately same-day. A later day's pending planning operation sharing progress/tasks can still block earlier-day resolution. Dates must not be silently rewritten.
4. **Ordinary saved edit support is bounded.** Non-conflicting task-field deltas are covered. Same-field concurrent changes throw a retained-review error; a complete user-facing field-conflict resolution flow has not been implemented here. Non-task ordinary effects, deletion/rescheduling corner cases, and previously reviewed/attempted successors can still fail closed.
5. **Remote terminal task plus local completion remains a recovery boundary.** The rebase refuses to revive a remotely completed/deleted task. How to retain/dismiss/reconcile that completion and its reward must align with newer S2 recovery, not be “fixed” by weakening the check.
6. **Latest Web continuation code needs independent scrutiny.** The proof graph, nested ancestry, predecessor selection, backup cross-binding, payload normalization, and recursive cost/storage growth deserve review. Tests cover simple chains and edits around a completion; they are not exhaustive proof for arbitrary interleavings, additions, malformed graph histories, long chains, or restore into nonempty state.
7. **UI copy still needs to explain multiple saved confirmations.** Backend can reopen the latest same-day proposal, while buttons still say “Review my order.” Review whether the user choice clearly covers all superseded local confirmations.
8. **Review refresh/staleness remains a concern.** A stored snapshot can age while another device changes state again. A subsequent confirmation must remain baseline/cost guarded; the whole repeated-conflict UX is not yet accepted.
9. **Server/client reward behavior must remain technically truthful.** Existing Web and Android reward formulas differ at some level-boundary details. This change intentionally preserves each existing formula; it does not claim to normalize the reward model. Verify actual authoritative behavior rather than hiding a mismatch.
10. **Staging rollout and HTTP 429 are untouched by this feature so far.** No new planning migration has been applied to a hosted project; no new feature deployment or client installation occurred. The upstream S2 report last described staging serving `5ea00f8` and failing exact-candidate checks. That is a report, not a fresh live verification. Reproduce the actual 429 before selecting a fix.
11. **No actual cross-device acceptance or final CI/release acceptance.** Mac behavior, older-client enforcement, native physical devices, full current browser suite, live database races, and final migration/Room/release matrices still need verification on the integrated candidate.

## Evidence and its limits

The handover's code snapshot was committed only after these local checks:

| Check | Result | Scope/limit |
| --- | --- | --- |
| Latest full Web/server unit suite | **772 passed, 112 files**, 9.20 s | Includes latest Web continuation work; local tests, not hosted acceptance |
| Latest TypeScript check | **PASS** | Exact Web source snapshot |
| Latest focused Web planning/completion suite | **39 passed, 2 files** | Includes continuations and edits before/after completion |
| Full Android unit suite | **244 tests: 243 passed, 1 skipped; 0 failures/errors**, 35 classes | Includes ordinary-edit recovery and dated UI; does not contain the unimplemented Android continuation feature |
| Earlier dated-review Chromium/WebKit checks | **8 passed** | Ran before latest pure sync changes; not the entire current E2E suite |
| Git whitespace check | **PASS** | Before source checkpoint |
| Hosted / physical cross-client / final CI | **NOT MEASURED for this checkpoint** | No acceptance claim |

Logs and Android skip details are committed under [planning-astra-handover-20260908](../operations/reliability/evidence/planning-astra-handover-20260908/). Earlier unit, browser, SQL, and native successes mentioned in preceding task work are not being promoted into exact-final-commit evidence here.

Two actual bugs already found/fixed during local recovery testing are worth preserving as lessons:

- Native request preparation once mutated original `JSONObject` admission members through aliasing. All original members must be cloned before deriving/fixing request fields.
- Native causal `generation` is the exact admission sequence, not a generic metadata version. Incrementing it merely for a receipt/proof update invalidates timeline replay. Web's generation semantics differ; do not copy that increment blindly.

## Code map: start here

| Area | Files relative to repository root |
| --- | --- |
| Policy and fixtures | `src/domain/deliberatePlanning.ts`, `src/domain/deliberatePlanning.test.ts`, `tests/fixtures/planning/deliberate-v1.json` |
| Main unresolved Web boundary | `services/deliberatePlanningStorage.ts` — `resolvePlanningReview`, `preparePlanningRequest`, `validatePlanningBackup` |
| Derivative/proof model | `services/planningCompletionRebase.ts` — `planningPredecessor`, `effectivePlanningEdit`, `effectiveCompletionMembers`, validators |
| Causal completion dependencies | `services/causalCompletionCoordinator.ts`, `services/causalSync.ts`, `services/causalCompletionProjection.ts` |
| Ordinary WAL, sync, backup | `services/syncProtocol.ts`, `services/storage.ts`, `services/cloudSync.ts` |
| Regression examples | `services/deliberatePlanningStorage.test.ts`, `services/causalCompletionCoordinator.test.ts`, `services/planningCompletionRebase.test.ts` |
| Web UI | `App.tsx`, `hooks/useDeliberatePlanning.ts`, `components/PlanningView.tsx`, `components/SavedPlanningDay.tsx`, `components/PlannedTaskBrowser.tsx`, `components/Modal.tsx` |
| Server | `server/deliberatePlanning.ts`, `server/routes/sync.ts`, `services/deliberatePlanningProtocol.ts`, `services/deliberatePlanningTransport.ts` |
| New SQL | `supabase/migrations/20260908180500_deliberate_planning.sql`, `20260908193000_planning_review_snapshot.sql`, `scripts/migration-planning-assertions.sql` |
| Android recovery | `android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/data/NativePlanningCoordinator.kt`, `NativePlanningCompletionRebase.kt`, `NativeCompletionAdmissionEvidence.kt`, `NativeCompletionRequestEvidence.kt`, `GoalflowBackup.kt`, `GoalflowRepository.kt` |
| Android tests | Corresponding `app/src/test/.../data/NativeCausalCompletionAdmissionTest.kt`, `NativePlanningCoordinatorTest.kt`, `GoalflowBackupTest.kt` |
| Mac | `macos-native/GoalflowMac/Domain/DeliberatePlanning.swift`, `Services/DailyPlanStore.swift`, `Sync/SyncEngine.swift`, `Sync/SyncTransport.swift`, related planning guards/tests |
| Newer S2 context | Read `docs/operations/reliability/S2_REPORT.md`, `S2_HANDOVER.json`, `S2_PROTOCOL_ADR.md` **from the current S2 branch**, not only this feature's older copies |

## What I need from Astra Pro

Please provide a concrete diagnosis and the smallest safe completion path, with file/function references:

1. Is retaining immutable originals plus derivative proof graphs justified here, or can the newer S2 dismissal/recovery primitives remove substantial complexity without losing intent, identities, rewards, or offline availability?
2. What exact semantics should apply when one rejected planning command has unattempted later confirmations, ordinary edits, and completions? Distinguish same-day and cross-day dependencies, and attempted from unattempted requests.
3. Review the newest Web supersession code for bugs. Identify a minimal counterexample/interleaving for each finding and the regression test that would prove a correction.
4. Recommend an integration sequence for latest S2 and this branch. Preserve all work; no force push, reset, or blind conflict resolution.
5. Specify what Android and macOS actually still need, and the minimal real-client/staging campaign that would establish the approved outcome.

Do not spend the review re-polishing the UI. The decisive work is correctness at the rejected-order/dependent-action boundary, integration with current S2, and honest hosted acceptance.

## Reproduction and operating constraints

Read repository `AGENTS.md` and its prescribed context files. `main` is not the promotion target. Do not touch the unrelated Movetrics Supabase project. Preserve task/account/action/mutation/receipt/conflict/tombstone/cursor identities. Never fabricate accepted receipts, mutate attempted request bytes, discard retained intent to unblock a queue, or revive a completed task. Existing published migrations are immutable. Do not merge, enable enforcement, or promote production from this WIP checkpoint.

From the feature worktree:

```sh
npm run lint
npx vitest run services/deliberatePlanningStorage.test.ts services/causalCompletionCoordinator.test.ts services/planningCompletionRebase.test.ts
npm test
```

Native local test recipe (JDK 21 and installed Android SDK):

```sh
cd android-native
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/Users/schober/Library/Android/sdk \
./gradlew -PgoalflowSkipSigning=true :app:testProductionDebugUnitTest
```

The signing bypass is for local debug tests only, not release proof. Keep hosted test skips explicit. A dependency symlink/node_modules setup exists in the local temporary worktree; a fresh GitHub checkout must install its own dependencies normally.
