# S1 report — local concurrency and persistence

**PASS_LOCAL** on tested implementation **`9f5457919d015d895d057e592ae7c5685f6a4d9c`**. The branch `codex/s1-local-durability-20260907` is pushed. No deployment, native installation or production promotion occurred. **Cross-device counter conservation remains gated by S2.** Personal beta release remains **NOT READY**.

## Baseline and boundaries

Fetched all branches/tags. This clean checkout began at `6f750a712f253754bfac840d8edc5d846b360b7d`, two commits after original audit `4ea2ab5edb7e07fb9f9f91ceea99b3ba197ea977`. The original handover `01f864720df7acfa211745e64edec8b5163ab612` and `35cda299d38eafb706f6680981d25845daf5cd0b` are ancestors. Natural-capture and native Mac changes in the newer candidate were retained. Baseline Beta Gate [34133747001](https://github.com/mariusschober/Tsurfing/actions/runs/34133747001) completed successfully. That is baseline evidence, not new-commit CI evidence.

No prerequisite stage was required. The original audit attachment was not supplied; the executable user prompt supplied the schedules. Current handovers, product constitution, package scripts, CI, storage/cloud-sync callers, bootstrap, migration, restore and recovery paths informed the implementation.

`/Users/schober/Projects/Goalflow` is absent. `/private/tmp/tsurfing-focus-integrated` exists at `bfb94c7` with uncommitted CI/index/browser changes and an untracked update-notice component; it and sibling worktrees were not modified. One integration branch was created in the clean TSurfing checkout. No reset, clean, stash, merge, force-push or owner-data test occurred.

Production browser paths are `services/storage.ts`, `services/syncProtocol.ts`, `services/cloudSync.ts`, `hooks/useGoalflow.ts` and React consumers. `android-native/` and `macos-native/` are the native clients; `android/` is preserved Capacitor. `tests/browser/s1Harness.ts` is imported only in Vite test mode; the production artifact gate confirms test backdoors are absent. Runtime/tool versions are in [inventory](evidence/inventory.json). No owner's running tab or installed service-worker build was inspected or equated with a branch SHA. The exact generated production/test artifacts have separate SHA-256 manifests.

## Reproductions and fixes

| Finding | Baseline evidence and disposition |
| --- | --- |
| S1-A | Two pages of one BrowserContext share profile/origin. Baseline failed peer task visibility and stayed active after peer pause. Repair rehydrates coherent refs/state without reload, even without a cloud pull. New stale focus admissions retain their original payload in blocked evidence. |
| S1-B | Controlled IndexedDB request barriers reproduce independent B outbox loss in preparation, receipt commit, success marking, conflict merge and both resolution paths. Latest read + modification + write now share one readwrite transaction. |
| S1-C | A real React Plan watcher held behind an injected clock created one extra mutation after newer hydration on baseline. Releasing it after repair creates zero actions: effects drain account intents, never captured snapshots. |
| S1-D | Before/during/after inbound admissions retain exact intent. Preexisting WAL materializes in the inbound transaction; later stale focus admission receives `STALE_FOCUS_INTENT`. Invalid inbound transition rolls back grouped writes and cursor together. |
| S1-E | Existing grouped WAL atomicity was retained. Account-scoped drains fix last-watcher/store dependence; completion + statistics + separate note edit remain represented. Real browser draft and failed-capture tests preserve editable text. |
| S1-F | Baseline fallback could resolve inbound application after metadata-first advancement and optional mirror writes. Repair refuses cursor advancement without IndexedDB; exact WAL and fallback bytes survive injected unavailability/mirror faults. |
| S1-G | Baseline equal-key-count replacement returned the old WAL collection. Removed time/length caches and idle warming callbacks. Actual content is read each time. |
| S1-OWNERSHIP | Durable original-intent journal survives WAL retirement and exact receipt acceptance; replaying a retired WAL cannot create another action. Explicit one-time migrations replace implicit hydration writers. |
| S1-RECOVERY | Synthetic connection replacement leaves original data and incompatible WAL intact. Automatic shadow activation is refused without a concurrent-admission fence. Raw destructive test setup now uses isolated fixture IndexedDB, preserving all recovery assertions. |

Baseline browser failures are retained in [baseline-browser.log](evidence/baseline-browser.log); metadata/cache failures in [baseline-metadata-cache.log](evidence/baseline-metadata-cache.log). The expanded baseline run intentionally fails new S1 assertions too: its 11 failures are **not** 11 independently proven defects. In particular, grouped commits already worked; the original-intent journal assertion describes a new durability obligation.

The exact ownership table and happens-before arguments are in [SYNC_INVARIANTS.md](SYNC_INVARIANTS.md). Strict receipt/wire validation was retained. No sum/max counter repair or reconciliation redesign was introduced. Legacy scalar ambiguity remains unresolved and preserved.

## Exact verification

All final commands below ran against implementation `9f5457919d015d895d057e592ae7c5685f6a4d9c`. The two connection fixtures are evidence-only additions exercising that same production source. Full release verification includes TypeScript, all unit/property tests, production builds, fail-closed server/maintenance checks, client-secret scanning and artifact checks. Detailed commands, exit codes, durations and logs are in [S1_COMMANDS.json](evidence/S1_COMMANDS.json).

| Command | Exit | Result |
| --- | --- | --- |
| `npm run verify:release` | 0 | Test Files  67 passed (67); Tests  403 passed (403) |
| `npm run verify:identifiers` | 0 | contract check passed |
| `npm run verify:migrations` | 0 | contract check passed |
| `npm run verify:migration-hashes` | 0 | contract check passed |
| `npm run verify:room-hashes` | 0 | contract check passed |
| `npm run test:s1:storage` | 0 | Test Files  2 passed (2); Tests  15 passed (15) |
| `npm run test:s1:storage` | 0 | Test Files  2 passed (2); Tests  15 passed (15) |
| `npm run test:s1:storage` | 0 | Test Files  2 passed (2); Tests  15 passed (15) |
| `npm run test:e2e` | 0 | 34 passed (27.0s) |
| `npm run test:s1:browser -- --repeat-each=3` | 0 | 30 passed (29.5s) |
| `npx vitest run docs/operations/reliability/connection-regression.test.ts` | 0 | 2 passed (2) |

This establishes 403 full-suite tests plus 2 additional connection/recovery fixtures; 34 full E2E tests; 15 S1 storage checks repeated three times; and 30 S1 browser executions (five schedules × two engines × three repetitions). Controlled schedules use explicit IDB event barriers and injected browser clocks. No randomized schedule failure was found; these schedules have no random seed. Existing fast-check properties ran in the release suite.

Production build identity: [production-build.json](evidence/production-build.json). Test/PWA build identity: [test-build.json](evidence/test-build.json). These are generated artifacts, not evidence of a deployed or owner-running build.

## Review and compatibility notes

- Every mutable metadata writer was moved inside the IndexedDB boundary, including manual cloud resolution and raw metadata merge. Transactions abort on transition/materialization failure. Network and asynchronous external work remain outside live transactions.
- `localState` is additive browser metadata: monotonic generation, original intent journal, exact receipt evidence, blocked reasons and migration markers. No PostgreSQL/Room/IndexedDB schema-version migration or durable identifier rename occurred. Unknown record fields and explicit null optional values remain preserved.
- Focus admission records carry their captured target identity/baseline. Incompatible new focus actions are preserved as blocked rather than overriding canonical state. Legacy payloads/IDs/times are unchanged. A blocked action is not silently retried or declared synced.
- Bootstrap uses audited `web-task-defaults-v1` and `web-progress-threshold-v1` transactions. Initializers read the latest value before deciding it is absent. Draft notes remain separate from shared task snapshots.
- Status events are account-checked and async validation is revision-checked. Peer success does not clear permanent errors. HTTP 403 no longer generically rejects the session; storage faults do not force authentication.
- Automatic database activation is intentionally unavailable until there is a safe admission fence. A verified shadow and the original database remain available; no pointer flip is claimed as repaired.

Two old source/performance tests demanded the removed unsafe implementation. Their retired assertions are preserved here, with their replacements testing the required ownership behavior:

```ts
expect(keyCalls).toBeLessThan(callsAfterFirst);
expect(keyCalls).toBeLessThan(20);
expect(file).toMatch(/300/);
expect(file).toMatch(/debouncedPersist|debounce/);
```

The cache test now requires a current scan; the hook test requires captured-intent draining and rejects snapshot writes. Recovery round-trip tests retained all assertions; only synthetic destruction setup moved away from production record APIs.

## Failed approaches and remaining gates

Initial sandbox runs could not write `.git/FETCH_HEAD` or bind loopback servers. Reviewed permission resolved both; no controls were bypassed. A temporary static browser harness lacked production CSP headers and had an offline-navigation failure in the broader suite. The unchanged repository E2E command subsequently passed all 34 checks with loopback permission. Missing-server-configuration diagnostics were informational; the earlier interpretation that they caused the startup block was corrected. A past-time Playwright clock setup and a status type error were fixed before final verification.

The workflow push filter excludes `codex/**`; no Actions run is listed for this new S1 branch. Hosted CI is therefore not claimed and must be arranged before promotion. Hosted dedicated-account matrices, native device/installation tests, signed artifacts, production infrastructure, deployment and release tagging were not executed. These are not local passes or prerequisites silently waived.

**Permitted next stage: S2**, from `9f5457919d015d895d057e592ae7c5685f6a4d9c` (the evidence follow-up changes no production source). S2 must establish cross-device counter conservation and resolve historical ambiguity without rewriting attempted requests. S3/rollout work must prove hosted/native behavior, old-tab/build update handling, recovery activation, deployment and release gates. Production release is not authorized.
