# Shared focus session installed — 2026-09-07

## Result

Web, native Android, and macOS now exchange one action-level focus session inside the existing tracking singleton. Start, pause, resume, duration extension, stop, and completion use the normal durable sync path. Display ticks remain local; passive expiry does not publish a stop or interrupt another client’s overtime.

Legacy macOS migration preserves elapsed time. Both a paused session (424 seconds elapsed / 1376 remaining) and active sessions with accumulated pauses have regression coverage. The installed Mac’s live session was migrated and reached staging. A later read-only check confirmed the Android recovery mirror and Mac tracking record were exactly equal, including session/task identity and elapsed anchor.

The existing break alarm fix remains: one finite alarm per break, effective cancellation, “Continue work” after expiry, and one status icon in the menu bar. Recorded tick/tock audio, Quit App, staging authentication, local DEBUG keychain opt-in, planning compatibility, and automatic conflict reconciliation are retained.

## Done interaction

The owner requested Frog completion holds of 3 seconds and regular holds of 1 second. A click or early release displays “Press and hold for … to mark as done” inside the Done button. The button is centered across the timer-control area. The bottom-of-panel instruction was removed. Releasing before the threshold cancels completion. Controller boundary tests cover both thresholds and cancellation.

## Installed and deployed

- Mac: `/Applications/Tsurfing.app`, build `2026090715`, ad-hoc development build with the same six public staging configuration values. Strict code-signature verification passed; login/data retained. Latest rollback copy: `~/Library/Application Support/Tsurfing-install-backups/20260907-143139-task-notes`.
- Android: connected TCL T807D, existing `com.mariusschober.tsurfing.dev` installation updated in place. Signing certificate matched the previous installation; no app data was cleared. Final APK SHA-256: `fb45bb820fd7dd20d10b6404c9797eede0ef978ec664780e8518cf811bacc54f`.
- Web/API: staging branch `codex/personal-beta-finalization-20260904`, commit `e4fca8d683235d684ce14d1fed8d16fd8492ada0`. Railway deployment `394cfa61-e8c1-4e0c-9a5f-28685103142d` succeeded. The real Brave tab loaded `/assets/index-DgIOoVmf.js`, matching the deployed page, and displayed the running shared task.
- Final native alignment and contrast refinements are on `fix/shared-focus-integrated-20260907`; they do not change the deployed web/API build.
- Server preservation and exact-receipt guards are deployed; see `CROSS_CLIENT_FOCUS_SERVER_2026-09-07.md`. Old daily-tracking writers cannot erase a newer focus session.

## Verification

- Web/API release checks: 64 test files, 367 tests passed; typecheck, build, startup, maintenance, client-secret scan and artifact checks passed.
- Mac integrated suite and shorter-hold suite: 215 tests, one explicitly skipped live cross-client test, zero failures. Final alignment-only build passed. Exact Done control rendered for initial, regular-instruction, and Frog-instruction states; alignment and text inspected.
- Android production-debug unit suite: 135 tests, one skipped, zero failures/errors; lint and configured build passed. The final contrast-only build passed. Actual phone UI showed the shared task, remaining time, and pause/stop/extension controls.
- Database: all 22 migration hashes, additive/static checks, durable identifiers and eight Room schema hashes passed. Full PostgreSQL fresh/upgrade suites passed locally and in hosted CI for the deployed integration commit.
- CI run `34126287031`: Mac, dependency audit, migrations, secrets, verify, legacy Android, web-release, and hosted-staging checks passed at the last inspection; native-android was still running.

## Evidence boundaries

The desktop automation surface could not bind to the Mac menu-bar app (timeout). Done control visuals were rendered from the exact SwiftUI control; the latest click interaction was not independently driven through the owner’s live Mac window. The original completion hold was exercised by the owner before these refinements. No fresh acoustic recording was made. No claim of production release, App Store release, notarization, or broad-device validation is made.

## Follow-up: notes and closed-task recovery

The owner’s real Test task notes were present in the Mac task store, proving synchronization; ExecutionPanelView had no notes display. The lower help-text area now shows a Notes section with selectable original text, preserved line breaks, content-sized height and a bounded 140-point scroll area for long notes. Both short and long cases were rendered with native NSHostingView and inspected; the final configured Mac build passed and was installed as build 2026090715. The Done click instruction remains inside the centered button.

Android startFocus now verifies that the requested task is still open and ignores an older focus record whose task is already completed, deleted, or broken down. This prevents a late tracking projection from blocking the next task. The production-debug unit suite and final configured APK build passed again.
