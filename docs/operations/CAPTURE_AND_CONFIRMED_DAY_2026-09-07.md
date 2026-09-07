# Quick Capture and confirmed-day corrections — 2026-09-07

## Behavior

A daily plan confirmed for the current local date stays valid when open tasks are added, completed, or reordered. Existing monthly and overdue planning gates remain. Web capture appends an ordinary new task after existing tasks for its scheduled date; existing frog, circadian, and APEX ordering continues to determine the queue. Native clients already append captured tasks.

Mac Quick Capture now uses a panel that can become key, restores title-field focus every time it opens, and reinstalls its scoped Escape handler on reopening. Confirming a selected date retains that choice. Add-and-start creates the shared focus record used by every client.

The Mac settings gear and Settings scene show the current global capture shortcut, default Command-Shift-G. Modifier and letter controls can change it; successful registration precedes saving and replacement of the previous registration. An unavailable shortcut reports an error and retains the working shortcut. Command-A remains normal text selection; add-and-start uses Command-Shift-Return.

## Verification and installed scope

- Web: TypeScript lint passed; 369 tests passed with local server access. An initial sandboxed full run could not bind local test ports and is not counted as code failure.
- Mac: 217 tests, 1 explicit live-sync skip, 0 failures. Final settings delegate routing was subsequently compiled successfully. Installed build `2026090717` retains all six public environment settings, existing authentication behavior, and local data; strict code-signature verification passed.
- Android: production-debug unit tests, lint, and APK assembly passed. Installed with replacement mode on the existing TCL device, without clearing data.
- Live Mac: the updated capture title field visibly contained the owner's text and was reported as focused. The owner's draft was left untouched. Automated shortcut customization and global key injection have not yet been independently proven in the live app.
- Mac backup: `~/Library/Application Support/Tsurfing-install-backups/20260907-150221-capture-settings`.

The reported web tracking recovery error is a separate fix and must be verified in the existing browser profile before claiming the sync problem resolved. This checkpoint does not establish public release readiness.

## Previous CI and async focus smoke test

Run `34126287031` on the previous staging commit passed web release, hosted staging, macOS, migration, security, dependency, and legacy Android jobs. Native Android failed when the smoke test asserted the focus screen immediately after starting the newly asynchronous shared focus save. The downstream cross-client and beta jobs therefore did not pass. The new smoke test explicitly waits, with the same bounded ten-second limit used elsewhere, for the Room-backed focus state before asserting that the screen is displayed. Its instrumentation Kotlin compilation passed; a successful emulator run remains required before calling that gate green.

## Tracking recovery

Read-only inspection of the owner's existing Brave profile identified two preserved same-day tracking WAL transactions: plan-view count 27 to 28, one carrying an older active focus projection and one carrying the newer completed projection. IndexedDB retained the completed projection with count 27 and an empty tracking outbox.

Recovery is bounded to same-day counter updates whose focus projection is unchanged from their own baseline. A strictly newer valid stored focus projection is retained. Ambiguous counter changes or conflicting focus actions still fail closed. Every original staged change and outbox fingerprint remains unchanged, including on attempted-request replay. Existing deployed server focus preservation prevents an older counter payload from reviving a completed timer.

The combined web release suite passed: 64 files, 369 tests, lint, web/Mini App/API builds, server startup, maintenance, client-secret and artifact checks. Settings rendering was inspected offscreen; all shortcut descriptions now fit without truncation. Live browser recovery and hosted deployment outcome are recorded after rollout verification.

## Live recovery result

- Staging commit: `4ea2ab5edb7e07fb9f9f91ceea99b3ba197ea977`.
- Railway deployment: `93b2b61f-c00f-484e-9557-14999d9cdf6e`, SUCCESS.
- Existing Brave error page initially remained on cached `index-DgIOoVmf.js`. The installed waiting service worker was activated through its existing `SKIP_WAITING` update handler. The error-only page had no editable draft and was then refreshed.
- Recovered page loaded `index-Cs0tfQ12.js`, rendered the owner's current focus session, and visibly showed `Synced`.
- Read-only local verification after convergence: 0 pending WAL transactions, 0 outbox mutations, 0 conflicts. The current focus projection reflected the owner's newer activity; the visible timer-expiry dialog was left untouched.
- Other existing tabs were not refreshed where an unfinished edit could not be ruled out. They can be reloaded after saving any draft to load the current app.
- Required CI for this exact candidate: `https://github.com/mariusschober/Tsurfing/actions/runs/34130889129`; do not treat an in-progress run as a pass.
