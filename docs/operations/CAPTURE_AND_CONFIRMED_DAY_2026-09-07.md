# Quick Capture and confirmed-day corrections — 2026-09-07

## Behavior

A daily plan confirmed for the current local date stays valid when open tasks are added, completed, or reordered. Existing monthly and overdue planning gates remain. Web capture appends an ordinary new task after existing tasks for its scheduled date; existing frog, circadian, and APEX ordering continues to determine the queue. Native clients already append captured tasks.

Mac Quick Capture now uses a panel that can become key, restores title-field focus every time it opens, and reinstalls its scoped Escape handler on reopening. Confirming a selected date retains that choice. Add-and-start creates the shared focus record used by every client.

The Mac settings gear and Settings scene show the current global capture shortcut, default Command-Shift-G. Modifier and letter controls can change it; successful registration precedes saving and replacement of the previous registration. An unavailable shortcut reports an error and retains the working shortcut. Command-A remains normal text selection; add-and-start uses Command-Shift-Return.

## Verification and installed scope

- Web: TypeScript lint passed; 367 tests passed with local server access. An initial sandboxed full run could not bind local test ports and is not counted as code failure.
- Mac: 217 tests, 1 explicit live-sync skip, 0 failures. Final settings delegate routing was subsequently compiled successfully. Installed build `2026090716` retains all six public environment settings, existing authentication behavior, and local data; strict code-signature verification passed.
- Android: production-debug unit tests, lint, and APK assembly passed. Installed with replacement mode on the existing TCL device, without clearing data.
- Live Mac: the updated capture title field visibly contained the owner's text and was reported as focused. The owner's draft was left untouched. Automated shortcut customization and global key injection have not yet been independently proven in the live app.
- Mac backup: `~/Library/Application Support/Tsurfing-install-backups/20260907-144746-capture-settings`.

The reported web tracking recovery error is a separate fix and must be verified in the existing browser profile before claiming the sync problem resolved. This checkpoint does not establish public release readiness.

## Previous CI and async focus smoke test

Run `34126287031` on the previous staging commit passed web release, hosted staging, macOS, migration, security, dependency, and legacy Android jobs. Native Android failed when the smoke test asserted the focus screen immediately after starting the newly asynchronous shared focus save. The downstream cross-client and beta jobs therefore did not pass. The new smoke test explicitly waits, with the same bounded ten-second limit used elsewhere, for the Room-backed focus state before asserting that the screen is displayed. Its instrumentation Kotlin compilation passed; a successful emulator run remains required before calling that gate green.
