# S1 corrected local acceptance

**PASS_LOCAL** at `09245261b6174ec878f0296ca61682c603f54304` on `codex/s1-local-durability-20260907`. Correction baseline: `8a7000d040a68cba4ce352e821430fbf1e70370a`; prior production implementation: `9f5457919d015d895d057e592ae7c5685f6a4d9c`. A subsequent documentation-only commit packages this evidence and is identified separately in Git history.

The original acceptance was incomplete. Its report and handover are preserved as `S1_INITIAL_REPORT.md` and `S1_INITIAL_HANDOVER.json`; the unchanged two failing review assertions and their original output remain in `S1_REVIEW.md`, `s1-review-regression.test.ts`, and `evidence/S1_review-regressions.log`. Both assertions now pass.

## Corrections

IndexedDB is authoritative when available. Reads overlay only valid unjournaled intent; stale fallback cannot hide committed records or resurrect acknowledged deletions. Recovery commits projection and exact-copy evidence atomically. Source keys remain intact because localStorage has no atomic compare-and-delete; unmatched peer replacements remain recoverable and block certification.

Explicit set no longer resolves after silently draining another write. It reads current state, materializes earlier intent and represents the requested value in the transaction, or rejects. UI persistence uses captured intent and drain APIs. Cloud seeding, initialization and day rollover now read current transactional state. Malformed rollover data is rejected rather than normalized away.

Grouped admission validates every member before applying any member. Blocked new groups retain the original envelope; ambiguous legacy groups retain exact bytes and fail closed. Metadata writers preserve current peer evidence. Resolved conflicts and exact reconciliation replies remain in additive local evidence.

Capture and asynchronous failures reach status; dirty notes remain editable on failure. Deferred drain work survives a transient fault. Obsolete account callbacks and status reads cannot overwrite newer state. Retry verifies local recovery even without a cloud client. Permanent cloud errors remain errors offline.

The requirement-to-entry-point/test mapping and complete metadata writer audit are in [S1_REQUIREMENT_MATRIX.md](S1_REQUIREMENT_MATRIX.md); happens-before and compatibility arguments are in [SYNC_INVARIANTS.md](SYNC_INVARIANTS.md).

## Exact-commit verification

| Command group | Exit | Result |
| --- | --- | --- |
| install | 0 | Passed |
| release | 0 | Test Files  70 passed (70); Tests  426 passed (426) |
| identifiers | 0 | Passed |
| migrations | 0 | Passed |
| migration-hashes | 0 | Passed |
| room-hashes | 0 | Passed |
| storage-1 | 0 | Test Files  5 passed (5); Tests  38 passed (38) |
| storage-2 | 0 | Test Files  5 passed (5); Tests  38 passed (38) |
| storage-3 | 0 | Test Files  5 passed (5); Tests  38 passed (38) |
| e2e | 0 | 64 passed (43.5s) |
| browser-repeat | 0 | 120 passed (1.2m) |

The browser repeat executes 20 controlled cases three times in each of Chromium and WebKit (120 executions), with two-tab cases sharing a BrowserContext and origin. The release command includes lint, unit/property tests, builds, server/maintenance checks and production client-secret/test-hook exclusion. Each of the three storage runs includes both original review assertions and the connection/recovery regression suite. Full E2E passed 64 executions.

An intermediate candidate passed 119/120 repeated browser executions. Its WebKit failure conflated resume with navigation from the Current planning gate. The corrected fixture enters Plan before suspension and resumes without navigation; the visibility assertion is unchanged. Twenty isolated repetitions and the complete final repeat pass. The failure log and candidate command manifests remain preserved; no failure is relabeled a pass.

Exact commands, durations, exit codes and counts: `evidence/S1_CORRECTION_COMMANDS.json`. Production/test build SHA-256 identities: `evidence/correction-release-build.json` and `evidence/correction-browser-repeat-build.json`. Runtime and historical-directory inventory: `evidence/correction-inventory.json`. Earlier candidate outputs have distinct `candidate-*` names. Final source diff whitespace check passed; raw historical logs are retained verbatim.

## CI and external boundaries

Exact implementation run: https://github.com/mariusschober/Tsurfing/actions/runs/34148397092. Machine-readable job outcomes, run status and IDs are retained in `evidence/correction-ci.json` and `S1_HANDOVER.json`. S1 has a narrowly scoped push trigger and repeated storage/browser checks; no deployment trigger was added. Hosted preflights fail closed before account activity because this candidate is undeployed and dedicated test-account authorization is unverified. Aggregate Beta Gate is **not green**. Final job outcomes: verify, migrations, secrets, dependency-audit, macOS, Android wrapper, native Android (including emulator), and web-release all passed. CI independently passed 426 unit/property tests, 64 E2E executions and 120 repeated S1 browser executions. Hosted staging and hosted cross-client preflights failed as blocked; beta-gate consequently failed. Artifact IDs and SHA-256 digests are retained in `evidence/correction-ci-artifacts.json`; selected test result lines are in `evidence/correction-ci-test-summary.log`. These CI artifacts were not installed or promoted.

Owner browser profiles, installed native clients, historical checkout changes and credentials were not modified. SQL/Room migrations, IndexedDB version, durable identifiers and wire formats remain unchanged. Additive local metadata is included in backups. Older running binaries still require a separately authorized rollout. Automatic database replacement remains blocked without a safe admission fence. Detailed note-conflict UX is outside S1.

**S1 establishes local storage and visibility correctness; cross-device counter conservation remains gated by S2; production release is not authorized.** S2 may start from `09245261b6174ec878f0296ca61682c603f54304`. Overall personal beta remains **NOT READY** until hosted authentication, cross-client convergence, recovery, signing and production release gates are proven.
