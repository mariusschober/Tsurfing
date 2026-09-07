# Web startup recovery — 2026-09-07

The owner's live Brave tab remained at “Hydrating Mind-State...” after reload. Browser console confirmed a DurableStorageError for a pending task whose recovered IndexedDB record differed from its write-ahead history. The deployed asset matched the server's current asset; this was not merely an old cached build.

The web storage layer now transfers divergent record edits into the existing automatic-reconciliation history atomically with the recovered record and sync ledger. Original mutation IDs, payloads, deletion markers, timestamps, and local order remain preserved. The recovered visible record is retained until the authoritative server returns its acknowledged timestamp-based decision. Fallback storage without an atomic ledger still fails closed.

Startup flushes pending local transactions before hydrating visible state. Remaining hydration exceptions display a plain-language retry screen while persistence stays blocked, preventing default state from overwriting saved data.

Validation: full `npm run verify:release` passed, including 357 tests across 63 files, type checking, production builds, server/maintenance checks, and client artifact/secret checks. Four new Chromium/WebKit browser cases passed for divergent-task reload and recoverable hydration failure. Ten existing Chromium/WebKit auth-focus cases also passed. The two earlier test failures during implementation were corrected before this checkpoint.

Staging deployment and owner-tab verification are recorded after deployment. Production promotion and native-client changes are outside this patch.
