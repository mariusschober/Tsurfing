# Web startup recovery — 2026-09-07

The owner's live Brave tab remained at “Hydrating Mind-State...” after reload. Browser console confirmed a DurableStorageError for a pending task whose recovered IndexedDB record differed from its write-ahead history. The deployed asset matched the server's current asset; this was not merely an old cached build.

The web storage layer now transfers divergent record edits into the existing automatic-reconciliation history atomically with the recovered record and sync ledger. Original mutation IDs, payloads, deletion markers, timestamps, and local order remain preserved. The recovered visible record is retained until the authoritative server returns its acknowledged timestamp-based decision. Fallback storage without an atomic ledger still fails closed.

Startup flushes pending local transactions before hydrating visible state. Remaining hydration exceptions display a plain-language retry screen while persistence stays blocked, preventing default state from overwriting saved data.

Validation: full `npm run verify:release` passed, including 357 tests across 63 files, type checking, production builds, server/maintenance checks, and client artifact/secret checks. Four new Chromium/WebKit browser cases passed for divergent-task reload and recoverable hydration failure. Ten existing Chromium/WebKit auth-focus cases also passed. The two earlier test failures during implementation were corrected before this checkpoint.

Staging deployment `1daef968-2522-4a77-8522-e1d75e746a33` succeeded for exact commit `c87d9c15f7d7081ebb9c5b509f325d5f5ae867c9`. The deployed entry asset is `index-BTbsWl55.js`.

The original owner Brave tab was recovered with a hard reload, showed the current task and Synced, and the available PWA update was activated. A subsequent ordinary reload completed successfully, again showing the current task and Synced, with no update prompt or loading loop. No browser storage was cleared and no owner task was edited during verification.

GitHub CI run `34116163672` was still in progress at this checkpoint; full CI completion is not claimed. Production promotion and native-client changes are outside this patch.
