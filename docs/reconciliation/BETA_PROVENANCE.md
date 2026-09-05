# Tsurfing beta provenance

> Naming update (2026-09-04): the product and GitHub repository are now
> Tsurfing / `mariusschober/Tsurfing`. Historical Goalflow identifiers, paths,
> artifacts, and links below are retained when they describe the evidence that
> actually ran. Compatibility-sensitive source namespaces, migration text,
> database/storage keys, and backup internals are intentionally unchanged.

Forensic inventory captured on 2026-09-03 before beta changes. This document is
the authority for branch provenance during the beta reconciliation. It records
remote state after a full fetch; it does not claim that any branch is safe to
deploy.

## Capture method and immutable reference point

- Repository: `mariusschober/Tsurfing` (public; authenticated repository access
  reports admin/push permission for `mariusschober`).
- Fetch: `git fetch origin --prune --tags '+refs/heads/*:refs/remotes/origin/*'`.
- Worktree immediately after fetch: clean at
  `main`/`84bd036ba25d825b5fae36cb780842d9221ed097`.
- GitHub default branch: `main`.
- Verified canonical baseline:
  `reconcile/canonical-main-20260831` at
  `6bd503605efe0ba4a92d57a6850e98590c1117a8`.
- Temporary local integration branch: `integration/beta`, created directly from
  that canonical SHA. `main` was not modified.
- Ahead/behind below is `canonical-only / branch-only`, calculated with
  `git rev-list --left-right --count canonical...branch`.
- “Branch delta” means the changed paths between the branch's merge base with
  canonical and the branch head. It is not a recommendation to port those
  paths.

GitHub reports every current branch as `protected: false`; the repository
rulesets collection is empty. The legacy branch-protection detail endpoint is
not readable by the installed GitHub integration, but the branch collection
independently confirms no branch is protected and no required checks are
attached.

## Remote branch ledger

| Remote branch | Exact head | Merge base with canonical | Canonical-only / branch-only | Branch delta | Contract age | Disposition |
| --- | --- | --- | ---: | --- | --- | --- |
| `main` | `84bd036ba25d825b5fae36cb780842d9221ed097` | `84bd036ba25d825b5fae36cb780842d9221ed097` | 152 / 0 | none | Obsolete; predates Supabase migrations and the shared sync contract | **SUPERSEDED**; retain as the production target, replace only after proof |
| `archive/main-pre-canonical-20260831` | `84bd036ba25d825b5fae36cb780842d9221ed097` | `84bd036ba25d825b5fae36cb780842d9221ed097` | 152 / 0 | none | Same obsolete tree as `main` | **DELETE-AFTER-PROOF**; exact head already tagged |
| `goalflow-production` | `2cf39f8227612286957632e095211f6eb1bce2d1` | `2cf39f8227612286957632e095211f6eb1bce2d1` | 4 / 0 | none | Direct ancestor of canonical; canonical adds release-gate and evidence hardening | **SUPERSEDED**, then **DELETE-AFTER-PROOF** |
| `reconcile/canonical-main-20260831` | `6bd503605efe0ba4a92d57a6850e98590c1117a8` | same | 0 / 0 | none | Current shared contract baseline | **ARCHIVE** until beta proof; stale PR #2 must be updated or replaced |
| `codex/goalflow-local-worktree-backup-2026-08-29` | `a0cecce49317d516e7a2d29978e658b39b5807ae` | `3cc0373f821105fb9a80ecf714f09578baf72bad` | 134 / 2 | 47 paths, +9,798/−1,341 | Older Room/sync/backup contract; its useful work is already present in newer form | **SUPERSEDED**, then **DELETE-AFTER-PROOF** |
| `goalflow-integrity-checkpoint-20260829-a867470` | `6ca8f8b71b9b34f74d28a709db6e70596710d6ba` | `3cc0373f821105fb9a80ecf714f09578baf72bad` | 134 / 1 | 46 paths, +9,684/−1,341 | Older checkpoint of the same Room/sync/backup work | **ARCHIVE** as evidence, then **DELETE-AFTER-PROOF** because the tag is durable |
| `codex/zero-data-loss-finalization` | `0ee98c87f961a854aa30ad3263542a2d783d1465` | `7a502cd6908b4ce5dfaad3216bd7a804aa4a1fd8` | 22 / 14 | 27 paths, +2,285/−186 | Based on an earlier shared contract; contains later hardening tests worth evaluating | **PORT** selective tests/session hardening only; never port its old migration blob wholesale; then **DELETE-AFTER-PROOF** |
| `sol/web-production-24h` | `34de3f49aab610fd7a4400c086f02186c1890f6d` | `6885df57dd4c49d68206798125c895474cb0a935` | 5 / 8 | 7 paths, +570/−6 | Web regression work predates canonical; much was already selectively ported | **PORT** only missing tests/diagnostics; reject its security weakening; then **DELETE-AFTER-PROOF** |
| `feature/macos-execution-companion` | `2d30375aa0b76fbae3061b672ce56f2fd313cb50` | `f93684ac50562c03c99328d98e57eb67f862eb3b` | 48 / 29 | 87 paths, +9,166 | Native app is newer isolated work, but its copied sync assumptions predate canonical | **PORT** the app on a branch from stabilized integration; conform to canonical rather than porting shared code backward |
| `feat/telegram-v1` | `5477ec362f3f08956706cca82294b3da62f49cc2` | `44f2e47f4d7e589f17a746c96cabf58e7b2fbb8a` | 44 / 6 | 33 paths, +4,071/−192 | Bot/Mini App work is newer isolated work on an older server/schema contract | **PORT** after core backend proof; migration must be additive and regenerated/reviewed against current migrations |
| `feature/chrome-execution-companion` | `c4e5d6820303d858831c71c3e22495c4c7195712` | `6825b38cf5a41efa8cff49736c12b0aa6c159e74` | 45 / 7 | 38 paths, +5,802 | Isolated demo-backed extension on an older contract | **POST-BETA**; preserve, do not integrate into the beta gate |

Snapshot differences against canonical are respectively: `main`/archive 302
paths; `goalflow-production` 48; local backup 147; integrity checkpoint 146;
zero-data-loss 95; web-production 52; macOS 201; Telegram 145; Chrome 152.
These large differences are why no divergent branch may be merged wholesale.

## Pull requests and last canonical CI

- PR #1, `codex/zero-data-loss-finalization` → `goalflow-production`, is open,
  draft, conflicting, and unmergeable at head
  `0ee98c87f961a854aa30ad3263542a2d783d1465`. It is superseded, but must not be
  closed until useful work is mapped to replacement commits.
- PR #2, `reconcile/canonical-main-20260831` → `main`, is open and mergeable at
  head `6bd503605efe0ba4a92d57a6850e98590c1117a8`, but its description and evidence
  still cite older candidate SHAs. Treat it as stale and do not merge it.
- CI run `33396021775` for PR #2 at the exact canonical head failed. `verify`,
  PostgreSQL migrations, and legacy Android passed. Full-history secrets,
  native Android instrumentation, WebKit, and therefore the aggregate
  `canonical-gate` failed. It is evidence for triage, not release evidence.
- Hosted account/RLS testing is still absent. No Railway or Supabase deployment
  is proven by repository or GitHub evidence.

## Audit-tag verification

Every pre-existing annotated audit tag peels to the exact recorded branch head:

| Preserved head | Peeling tag |
| --- | --- |
| `84bd036ba25d825b5fae36cb780842d9221ed097` | `main-pre-canonical-20260831` |
| `2cf39f8227612286957632e095211f6eb1bce2d1` | `audit/2026-08-31/goalflow-production` |
| `34de3f49aab610fd7a4400c086f02186c1890f6d` | `audit/2026-08-31/sol/web-production-24h` |
| `0ee98c87f961a854aa30ad3263542a2d783d1465` | `audit/2026-08-31/codex/zero-data-loss-finalization` |
| `5477ec362f3f08956706cca82294b3da62f49cc2` | `audit/2026-08-31/feat/telegram-v1` |
| `2d30375aa0b76fbae3061b672ce56f2fd313cb50` | `audit/2026-08-31/feature/macos-execution-companion` |
| `c4e5d6820303d858831c71c3e22495c4c7195712` | `audit/2026-08-31/feature/chrome-execution-companion` |
| `6ca8f8b71b9b34f74d28a709db6e70596710d6ba` | `audit/2026-08-31/goalflow-integrity-checkpoint-20260829-a867470` |
| `a0cecce49317d516e7a2d29978e658b39b5807ae` | `audit/2026-08-31/codex/goalflow-local-worktree-backup-2026-08-29` |

The canonical reconciliation head was the only untagged current remote head.
It is preserved by the new annotated tag
`audit/2026-09-03/reconcile/canonical-main-20260831`, which must peel to
`6bd503605efe0ba4a92d57a6850e98590c1117a8`. The integration branch does not
receive a second tag while it points to the same object.

## Branch-specific evidence and port boundaries

### Obsolete main and archive

There are no branch-only commits or paths after their merge base. Their tree
contains no `supabase/migrations` directory and no current cross-client sync
contract. The old head is provenance only; it is not a viable code source.

### `goalflow-production`

There are no branch-only commits or paths. It is an exact ancestor of canonical
and already contains the seven ordered SQL migrations from
`202607170001_foundation.sql` through
`202608310001_telegram_auth_state_pkce.sql`. Canonical is newer by four commits
covering reconciliation documentation, migration/Room hash guards, golden
fixtures, PWA/WebKit gates, and fail-closed CI. Nothing should be ported from
this branch.

### Local-worktree backup and integrity checkpoint

The backup has two unique commits (`23d430c`, `a0cecce`); the checkpoint has one
(`6ca8f8b`). Both introduce an early form of the same 46-path integrity tranche:
Room database/repository/sync/session changes, the
`202608260001_zero_silent_data_loss.sql` migration, backup/restore scripts,
server sync routes, and TypeScript property/adversarial tests. The backup adds
one extra handover document. No test path exists there but not in canonical.
Canonical has materially newer schema, Room versions, account binding, and
protocol behavior; direct porting would regress durable contracts.

Branch-delta paths common to both (the backup also adds
`docs/AI_CONTEXT_HANDOVER.md`):

```text
.github/workflows/ci.yml
App.tsx
AppWrapper.tsx
DATA_INTEGRITY_HANDOVER.md
android-native/app/build.gradle
android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/{GoalflowApplication.kt,MainActivity.kt}
android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/data/{GoalflowBackup.kt,GoalflowDatabase.kt,GoalflowJson.kt,GoalflowRepository.kt}
android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/sync/{NativeSyncEngine.kt,NativeSyncWorker.kt,SecureSessionStore.kt}
android-native/app/src/main/java/com/mariusschober/goalflow/nativeapp/ui/{GoalflowRoot.kt,GoalflowViewModel.kt}
android-native/app/src/test/java/com/mariusschober/goalflow/nativeapp/data/{GoalflowBackupTest.kt,GoalflowDatabaseMigrationTest.kt,GoalflowRepositorySyncTest.kt}
android-native/app/src/test/java/com/mariusschober/goalflow/nativeapp/sync/NativeSyncEngineTest.kt
components/SyncStatus.tsx
hooks/useGoalflow.ts
package.json
scripts/{migration-current-seed.sql,migration-integrity-assertions.sql,restore-production-backup.ts,supabase-test-bootstrap.sql,test-postgres-migrations.sh,verify-data-integrity-migrations.mjs}
server/{app.ts,backups.test.ts,backups.ts,taskReconciliation.ts}
server/routes/{sync.test.ts,sync.ts,tasks.ts,telegram.ts}
server/telegram/bot.ts
services/{backupCrypto.test.ts,cloudSync.adversarial.test.ts,cloudSync.ts,storage.test.ts,storage.ts,syncProtocol.property.test.ts,syncProtocol.ts}
supabase/migrations/202608260001_zero_silent_data_loss.sql
```

### `codex/zero-data-loss-finalization`

Fourteen unique commits range from documentation through PostgreSQL/Room fixes
to session and fault-injection hardening. It directly modifies an already named
historical SQL migration; that blob must never overwrite canonical migration
history. Its eight tests absent from canonical are candidates for semantic
porting:

```text
android-native/app/src/test/java/com/mariusschober/goalflow/nativeapp/sync/Tranche2ConformanceTest.kt
server/auth/secureCallback.test.ts
server/routes/telegram.secure.test.ts
server/telegram/miniApp.secure.test.ts
services/crossClient.test.ts
services/faultInjection.test.ts
services/sessionRecovery.test.ts
services/syncHealth.test.ts
```

The full branch delta is those tests plus CI/docs; Room schema 7 and migration
instrumentation; `GoalflowDatabase.kt` and `GoalflowRepositorySyncTest.kt`;
`scripts/test-postgres-migration-case-regression.sh`;
`server/auth/secureCallback.ts`; `services/authService.ts`; and the historical
`202608260001` SQL blob. Each test must be checked against real current code;
source-string, fake-map, or obsolete-contract assertions are not release proof.

### `sol/web-production-24h`

Eight unique commits add a web handover and the first Chromium/WebKit release
journey. The seven branch-delta paths are:

```text
.github/workflows/ci.yml
docs/WEB_PRODUCTION_24H_HANDOVER.md
package-lock.json
package.json
playwright.config.ts
server/app.ts
tests/e2e/web-critical.spec.ts
```

Canonical already has independently ported Playwright configuration and the
critical spec, so no test path exists only on this branch. The branch's
`server/app.ts` weakens HSTS/CSP/rate-limit behavior and is explicitly rejected.
Only missing diagnostics or assertions may be ported after line-by-line review.

### `feature/macos-execution-companion`

Twenty-nine unique commits create an isolated Swift application. There are no
shared server or SQL branch-delta paths. Its 87 paths comprise `appcast.xml`,
`scripts/package-dmg.sh`, seven macOS documents, Xcode project/configuration and
assets, 51 production Swift files, and these 15 tests:

```text
macos-native/GoalflowMacTests/BreakTests.swift
macos-native/GoalflowMacTests/BreakdownTests.swift
macos-native/GoalflowMacTests/CalendarTests.swift
macos-native/GoalflowMacTests/CaptureServiceTests.swift
macos-native/GoalflowMacTests/CaptureTests.swift
macos-native/GoalflowMacTests/CaptureViewModelTests.swift
macos-native/GoalflowMacTests/ExecutionStateTests.swift
macos-native/GoalflowMacTests/ExecutionTimerTests.swift
macos-native/GoalflowMacTests/FocusSessionStoreTests.swift
macos-native/GoalflowMacTests/HardeningTests.swift
macos-native/GoalflowMacTests/PlanningGateTests.swift
macos-native/GoalflowMacTests/SchedulingTests.swift
macos-native/GoalflowMacTests/SessionBTests.swift
macos-native/GoalflowMacTests/SessionCTests.swift
macos-native/GoalflowMacTests/SyncTests.swift
```

Protocol-relevant app paths are `macos-native/GoalflowMac/Sync/*`,
`Services/SupabaseAuthService.swift`, `Services/KeychainSessionStore.swift`,
`Services/DailyPlanStore.swift`, `Services/GoalStore.swift`, and
`Providers/SyncBackedCurrentTaskProvider.swift`. These definitions must be
adapted to canonical schema/protocol behavior; they are not a competing source
of truth. Preserve bundle ID `com.mariusschober.goalflow.mac`, URL scheme
`goalflow`, durable IDs, and Keychain identity.

### `feat/telegram-v1`

Six unique commits create modular bot capture, scheduling/pending state,
forward/voice handling, Mini App authentication/UI, and one proposed migration.
The schema delta is
`supabase/migrations/202609010001_telegram_rich_capture.sql`; it is absent from
canonical and follows a branch that lacks canonical migration
`202608300001_complete_native_sync_transport.sql` and
`202608310001_telegram_auth_state_pkce.sql`. It therefore requires additive
reconciliation rather than copying into the chain unexamined.

Tests existing only on this branch:

```text
server/routes/telegramMini.test.ts
server/telegram/bot.adversarial.test.ts
server/telegram/bot.test.ts
server/telegram/formatting.test.ts
server/telegram/forward.test.ts
server/telegram/miniAppAuth.test.ts
server/telegram/pending.test.ts
```

Other branch-delta paths are `App.tsx`, four Telegram planning/status documents,
`package.json`, `server/app.ts`, the corresponding server modules under
`server/routes/` and `server/telegram/`, `telegram-mini-app/*`, and
`vite.mini.config.ts`. Production remains disabled until live Telegram proof.

### `feature/chrome-execution-companion`

Seven unique commits add an isolated Manifest V3 extension and two documents.
All 38 branch-delta paths are under `chrome-extension/` except the documents.
There is no shared schema/server delta. Its only-branch tests are:

```text
chrome-extension/tests/demoCurrentTaskProvider.test.ts
chrome-extension/tests/executionState.test.ts
chrome-extension/tests/executionTimer.test.ts
chrome-extension/tests/focusSessionStore.test.ts
chrome-extension/tests/scheduling.test.ts
```

The presence of `DemoCurrentTaskProvider` and absent canonical account/sync
integration makes this post-beta work, not a beta dependency.

## Selective-port execution ledger

This ledger records the temporary beta branches created from canonical. It is
append-only evidence of what replaced useful divergent work; none of these
heads is a production release merely because it exists.

| Temporary branch | Exact remote head | Base relationship | Current purpose |
| --- | --- | --- | --- |
| `integration/beta` | `87ae3259de5419c41c3e4add290a889b831f9380` | 19 commits after canonical | Proven web/server/auth/sync/backup integration base; `main` remains untouched |
| `feat/macos-beta` | `b0337ca0527d999cc9a74e2196373839d3049e32` | 16 commits after `integration/beta` | Selective macOS transplant plus shared protocol repairs and the corrected Android v2 migration fixture |
| `feat/telegram-beta` | `4d36dc11a9bf4e83d6dbb882c4c94e9de7ee4eb3` | 9 commits after `feat/macos-beta` | Selective bot/Mini App transplant plus additive-migration and PostgreSQL verification hardening; feature remains disabled pending live verification |
| `chore/railway-beta-gate` | implementation head `7d491c882ccb9e02691e2fe007ee0efce91eceee` | 60 commits after `feat/telegram-beta`; 104 after canonical; 85 after `integration/beta` | Repository-backed Railway cron, hosted browser/native handoff harnesses, fail-closed release/signing/key/audit gates, backup/restore verification, web/native auth and transport hardening, complete Android installed-upgrade fixtures, visible device launch proof, and retained macOS beta artifact |

Useful `sol/web-production-24h` behavior is replaced by current WebKit and
production work in `ca2b1eb`, `a62a1be`, and the `beta-gate` workflow in
`f437888`. Useful session, revoked-token, timeout, ownership, and restore
hardening identified on `codex/zero-data-loss-finalization` is represented by
the current-contract commits from `955a340` through `87ae325`; the historical
SQL blob and mutable deployment workflow were not copied.

The native macOS application was introduced by `ee52d36` and subsequently
hardened without merging its historical branch. Commits `8ae2fbd` through
`d0e60bd` bind local workspaces to immutable accounts, make local mutation
journaling recoverable, validate canonical response envelopes and receipts,
preserve numeric/task/goal wire values, and surface corrupt storage rather than
falling back to demo synchronization. `b0337ca` corrects the Android migration
matrix to model the version-2 snapshot identity actually shipped (`singleton`)
while retaining exact assertions for tasks, tombstones, payloads, timestamps,
mutation IDs, dependencies, conflicts, events, and account IDs.

The Telegram transplant is represented by these exact remote commits:

```text
0768288 fix(telegram): claim webhook updates atomically
b1a4dc8 feat(telegram): add replay-safe Mini App sessions
f1c5da3 fix(telegram): enforce account-bound bot access
06024e7 feat(telegram): parse explicit rich schedules safely
3d86b55 feat(db): confirm Telegram captures atomically
26629c1 feat(telegram): preserve capture intent durably
c03e51e docs(reconciliation): record selective beta ports
cebd65f test(db): sequence Telegram unlink verification
4d36dc1 ci: freeze additive Telegram migration names
```

The historical `202609010001_telegram_rich_capture.sql` was deliberately not
ported: it added columns omitted by the canonical transactional restore
function, which would have made a restore silently discard capture metadata.
Instead, rich pending intent uses a versioned envelope in the already-backed-up
`telegram_captures.transcript` field; forwarded user-visible content is written
to the existing task `notes` field inside the same idempotent creation
transaction. New additive migration
`202609030007_telegram_capture_confirmation.sql` locks the pending capture,
checks active ownership, creates or replays the deterministic task, and marks
the capture confirmed atomically. Duplicate Telegram delivery and two
intentionally identical messages therefore remain distinct concepts.

The PostgreSQL unlink regression did not justify another schema migration. Its
test combined a mutating RPC with a state read in one boolean expression even
though PostgreSQL does not guarantee subexpression evaluation order. Commit
`cebd65f` stores the RPC result before inspecting durable state, proving the
existing transaction instead of changing production data semantics. Commit
`4d36dc1` adds migrations `202609030004` through `202609030007` to the frozen
hash ledger; no previously applied migration was edited.

The first operational beta-gate tranche is represented by these exact remote
commits:

```text
ec44e00 fix(ops): model maintenance as repository cron
772a254 test(staging): add hosted isolation and sync proof
851fb2c ci: require hosted proof on release candidates
ebd512c test(android): emit complete migration fixture SQL
5381121 fix(release): require main-specific beta proof
59a7ded fix(macos): fail closed during packaging
27b1330 ci(macos): retain an honest beta artifact
57c3a59 docs(ops): make Railway promotion explicit
2b093c6 fix(auth): keep demo identity synthetic
2a01fdb docs(beta): retire obsolete release instructions
5a85896 docs(reconciliation): record operational beta tranche
8c9c6f7 test(staging): prove hosted browser convergence
```

The hosted harness requires an explicit staging guard and two distinct expected
Supabase UUIDs. It proves real sign-in, refresh, ownership isolation, forged
owner rejection, duplicate-delivery convergence, lost-acknowledgment retry,
conflict handling, tombstones, isolated account export, safe account-deletion
refusal, malformed-token errors, remote global logout, and an independently
authenticated second user-A session when the nine staging secrets exist.
Commit `8c9c6f7` adds a separate production-origin Playwright gate: two user-A
browser profiles must converge across UI create/edit/delete operations while a
user-B browser must never render that task. Each mutation requires a newly
observed `syncing` to `synced` cycle; a pre-existing green status is not accepted
as acknowledgment. Credential-bearing browser media is disabled and only
redacted diagnostics are retained. A partial secret set fails on every branch;
a wholly absent set may skip only on short-lived `feat/*`, `fix/*`, or `chore/*`
branches. It fails closed on `main`, `develop`, and `integration/*`.

The Android correction in `ebd512c` does not alter a durable entity ID. The
instrumentation fixture used unparenthesized Kotlin `+ if (...) ... else ...`
expressions, causing versions 3 and later to emit only an INSERT column list
and fail with SQLite `incomplete input`. Parenthesizing each conditional
fragment now emits complete SQL while retaining exact assertions for IDs,
timestamps, tombstones, outbox dependencies, conflicts, events, and account
binding.

GitHub Actions run
[`33772320743`](https://github.com/mariusschober/Goalflow/actions/runs/33772320743)
at exact commit `ebd512c` is the hosted proof for that correction. Its
`native-android` job completed successfully: APK zip/alignment/signature
diagnostics passed, the test-only APK installed cleanly and rendered its first
frame, and `connectedProductionDebugAndroidTest` finished all 7 tests on the
API-30 emulator with zero skipped and zero failed. The same run's migrations,
verify, web-release (Chromium and WebKit), legacy Android, and macOS jobs also
passed. The aggregate gate correctly remained red solely because the historical
Firebase/GCP credential still lacks owner disposition; hosted staging was an
allowed absent-configuration preflight on this short-lived branch, not a live
Supabase pass.

GitHub Actions run
[`33773461445`](https://github.com/mariusschober/Goalflow/actions/runs/33773461445)
at exact commit `57c3a59` completed the macOS unit and release-build job and
retained artifact `goalflow-macos-ad-hoc-beta` (artifact ID `9900689841`,
1,148,508 compressed bytes). The job verified the ad-hoc code signature and the
archive's SHA-256 checksum before upload and recorded the source commit and
non-notarized signing mode. This is a development-signed beta candidate, not a
notarized production release and not hosted-sync evidence.

Local `npm run verify:release` at `57c3a59` passed 37 test files / 213 tests,
TypeScript, all production builds, production boot and maintenance fail-closed
checks, client scans, PWA artifact validation, and the high-severity dependency
audit. This is local evidence only; it does not satisfy hosted staging,
emulator, signing, credential, backup/restore, or live Telegram gates.
At `8c9c6f7`, `npm run lint` and the complete unit/property suite pass with 38
test files / 217 tests. The hosted command was separately shown to reject a
missing staging guard, and the ordinary Playwright configuration lists only its
eight Chromium/WebKit synthetic journeys. The live hosted browser journey
remains unexecuted until staging exists.

The second operational hardening tranche is represented by these exact remote
commits. It is additive application, test, CI, and documentation work; it does
not edit or add a database migration:

```text
a009a8f4582c09c2f6e79d2ce4b7899568d605e1 docs(beta): record browser and emulator evidence
e8e926ff3a2f9c8d5094b8c5ea6f249946ba4667 test(staging): revoke hosted test sessions
79d8ea9578921d2220a99b16e83cde9a6a16b696 fix(release): require one verified APK signer
f33bf98b19fc201263c87da4eb867b3273dbca9a fix(android): remove decoded signing material
f4134fc62a7922a48d51c15f62ec9f13a5605bed fix(security): enforce Supabase key roles at build
5b4ed903ef9abf5580826fbb0f524c33e4da0b27 fix(macos): reject server keys in app bundles
70fb4a61c9caf6634644a186a44d069ff9c1778a test(maintenance): use role-correct Supabase keys
157b5338215af54fcecbfbe0f7e89660b81d2083 fix(backups): verify uploaded objects before completion
db26fc33d57d6ad1d5e1e121525d6e0656fa41d6 fix(restore): verify restored row content
0f641dbf3615201559948afdf1d4d44e1e0ca2cc fix(web): bound complete auth and sync responses
f05d52735d907c0edaac2ce36a2490a8ca65c8ed fix(auth): subscribe before initial validation
eee4af0300eb42392df6204d348f4c06bee00a65 fix(ci): use runner PostgreSQL for migrations
f9ceb6a6d742111897fa22f0d21729c24e625f19 fix(macos): fail closed on bundle inspection
6ecfb5dcd2f2f87946766490c93811e8c3abc0fb fix(macos): fail closed on source discovery
9f04d34a05abd0f91892285cf2d91cdb8ca9d805 fix(auth): scope owner gate to admin routes
cb72a806d469f366b05e53a17377a23d4784d147 fix(macos): use portable source discovery
6cd699087ed4f5c923f031d1bee9982e41ff9d85 fix(auth): verify session termination results
123475b36aae7e044dc0ee3707f2069df2a8e5a1 feat(android): support owner MFA elevation
480c225ba899b620e1490fd0edaa8bbec2aeeaca ci: cancel superseded branch gates
85586fb4fd7b359718ab493a1b2d4cd55c0171ce fix(web): cap buffered API responses
122f5e700c096c4393326bf5ba61a4d6288d144e fix(android): bound synchronization responses
22b8b5dbbc30e997f7fc66c46284bb7e4c5eacbf fix(android): surface corrupt cloud sessions
```

This tranche makes signing require one expected certificate, prevents decoded
keystore material from surviving the release step, and rejects Supabase
server-secret key forms in every distributable. Backup completion now requires
read-after-write byte and authenticated-decryption verification; restore
completion re-exports and compares committed content, not only row IDs and
counts. Web authentication subscribes before initial validation, bounds full
response reads, and surfaces local/global sign-out failures. Native Android
can elevate the owner through a project-bound TOTP challenge, caps sync
responses, and reports damaged encrypted session state while retaining Room
data and pending mutations. The CI concurrency key cancels only older runs for
the same ref; the newest exact commit must still finish every required job.

Local verification at `22b8b5d` passed 46 Vitest files / 245 tests, TypeScript,
production client/server/Mini App builds, production boot and maintenance
fail-closed checks, current-tree client scans, all migration and Room hash
ledgers, durable identifiers, shell syntax, and the high-severity dependency
audit with zero reported vulnerabilities. GitHub Actions run
[`33782495962`](https://github.com/mariusschober/Goalflow/actions/runs/33782495962)
subsequently completed: its internal implementation jobs passed and its
aggregate correctly failed the unresolved complete-history credential scan.
Hosted staging proof was an absent-configuration preflight. This historical
checkpoint predates the installed-upgrade and signed-artifact hardening below
and is not represented as the current candidate.

The third release-gate tranche is represented by these exact remote commits:

```text
818d61a docs(reconciliation): record release hardening tranche
9db420f docs(beta): add evidence-based readiness ledger
be5d5e1 ci: scan candidate after history findings
b10352e test(android): prove installed upgrade data retention
302af78 test(android): pin upgrade source evidence
08bfe1a test(android): accept fail-closed APK handoff layout
81fcf40 ci(android): add signed internal beta gate
32e7c67 docs(security): retire historical Android test signer
9d38763 ci(android): scope internal signer environment
2b2189c fix(ci): use POSIX emulator script contract
da30768 fix(android): stabilize Robolectric dependency resolution
3ced314 fix(ci): gate signed APK on integration push
9cbd161 fix(ci): keep emulator gate in one shell
46eea5f fix(android): verify installed upgrade test target
37c5cf1 fix(android): run instrumentation without UTP installer
f114042 fix(android): cold-start preserved upgrade fixture
8cac2c9 fix(android): verify rendered cold launches
aa014fe fix(android): verify visible cold launches
```

The signed Android workflow is restricted to an exact `integration/beta` push
and the protected `internal-beta` environment. It requires one external
signer, its independently configured SHA-256 certificate fingerprint, and only
the three public staging values in the APK. Ordinary CI compiles an unsigned
production release and cannot emit a release artifact accidentally. The
signed job remains unexecuted because no beta signer or live staging
configuration has been supplied.

The Android device gate was repaired from evidence rather than by changing the
expected durable UUID. Run
[`33790070003`](https://github.com/mariusschober/Goalflow/actions/runs/33790070003)
proved all seven current instrumentation tests, then showed that `aapt badging`
omitted optional instrumentation target metadata. Commit `46eea5f`
changed the gate to verify the installed Package Manager binding. Run
[`33793009895`](https://github.com/mariusschober/Goalflow/actions/runs/33793009895)
then exposed a Gradle UTP installer/device-property failure before any upgrade
assertion. Commit `37c5cf1` installs the exact compiled application and test
APKs directly, verifies their binding, and requires the exact seven-test
result; it does not retry or skip the tests.

Runs
[`33796040203`](https://github.com/mariusschober/Goalflow/actions/runs/33796040203)
and
[`33798480455`](https://github.com/mariusschober/Goalflow/actions/runs/33798480455)
both passed those seven tests and the preserved-version seed but revealed that
`am start -W` times out on the headless API-30 image even after explicit
process death. Run
[`33801111276`](https://github.com/mariusschober/Goalflow/actions/runs/33801111276)
proved the exact process and activity were live/resumed while the ATD
`gfxinfo` counter remained zero, so a zero/nonzero frame counter was not used
as a false release oracle. Commit `aa014fe` instead requires the device
accessibility hierarchy to contain the exact Goalflow package and visible
`Current` or `Capture` semantics; process existence alone cannot pass. Failure
retains synthetic-device activity state, UI XML, and a screenshot.

GitHub Actions run
[`33806219844`](https://github.com/mariusschober/Goalflow/actions/runs/33806219844)
at exact implementation commit
`aa014fe898b2beb9d0aee95770338fd86c4ecc50` is the preceding installed-upgrade
proof.
`verify`, clean PostgreSQL `migrations`, `web-release`, legacy `android`,
`native-android`, and `macos` all succeeded. Chromium and WebKit passed all
eight critical journeys; macOS passed 175 tests and its build. Native Android
proved visible clean, preserved-v2, and upgraded-v3 UI; exactly seven current
instrumentation tests; versionCode `2->3`; and exact preservation of two task
rows, three outbox rows, a tombstone, a dependency, account binding, cursor,
timestamps, and durable IDs. Its final markers were
`UPGRADE_DATA_PRESERVATION=PASS`, `UPGRADE_MATRIX=PASS`, and
`EMULATOR_GATE=PASS`.

The same run's candidate/event scan was clean. Complete-history scanning
examined 311 commits and found exactly the one unresolved historical
Firebase/GCP key (`history_status=1`, `tree_status=0`), so `beta-gate`
correctly remained red. Hosted staging steps were skipped under the explicit
short-lived-branch rule, and the signed internal APK job did not run. Those
external proofs remain release blockers, not implied successes.

The fourth release-gate tranche is represented by these exact remote commits:

```text
cd3fa2d docs(beta): record exact internal gate evidence
6d97314 test(android): prove hosted sync transport handoff
bbf9722 test(macos): prove hosted sync transport handoff
e047f83 ci(beta): require hosted cross-client convergence
ef343c3 fix(ci): initialize cross-client state on runner
3f401ea fix(ci): pin bounded dependency audit
3d66b44 docs(beta): record cross-client gate evidence
7d491c8 fix(ci): replace flaky npm advisory audit with OSV
```

The new hosted cross-client job uses one private runner handoff containing only
a durable task UUID and unique test titles. A real hosted browser creates the
task; the production Android sync engine pulls, edits, pushes, and requires its
exact outbox acknowledgment; a fresh browser verifies the edit and user-B
isolation; the production macOS URL-session transport repeats that sequence
using a test-only Keychain namespace; and fresh A/B browsers verify deletion.
Cleanup is always attempted after seeding. Partial staging configuration fails
on every branch, and wholly absent configuration may pass only the explicit
preflight on a short-lived branch. No live step has run yet.

The first workflow version was rejected by GitHub before any job because a
runner-only context was used at job scope. Commit `ef343c3` moves that state
path initialization into a runner step. The accepted run then exposed npm 10
falling back to a retiring audit endpoint that rejected the valid npm 11 lock
tree without reporting a vulnerability. Commit `3f401ea` introduced a pinned,
bounded npm 11 audit and run `33818026484` passed it. The next exact-head run
`33819988586` proved that npm's advisory request could still hang until the
entire three-minute command timeout. Commit `7d491c8` replaces that unreliable
network dependency with a separate OSV Scanner job pinned to an immutable
action commit. It scans the exact lockfile and is a required dependency of both
the aggregate and signed internal-beta jobs; missing input, scanner failure,
timeout, or a finding remains fatal.

GitHub Actions run
[`33821008399`](https://github.com/mariusschober/Goalflow/actions/runs/33821008399)
at exact implementation commit
`7d491c882ccb9e02691e2fe007ee0efce91eceee` is the current internal proof.
`dependency-audit`, `verify`, clean PostgreSQL `migrations`, `web-release`,
legacy `android`, `native-android`, and `macos` succeeded. OSV scanned all 749
packages represented by `package-lock.json` and found no issues. Chromium and
WebKit passed all eight critical journeys. macOS executed 176 tests with the one
live hosted test explicitly skipped, verified its ad-hoc signature/checksum,
and retained artifact `9918299195` with digest
`sha256:b5cfb7b6ecb3f381d80457ec1d244bbf961fdf7e488321f766aa84dcd41d4e4e`.
Native Android again emitted `UPGRADE_DATA_PRESERVATION=PASS`,
`UPGRADE_MATRIX=PASS`, and `EMULATOR_GATE=PASS` after the exact seven-test
installed-upgrade matrix.

The event and candidate-tree scans were clean. The complete-history scan
examined 319 commits and found only the unresolved historical Firebase/GCP key
(`history_status=1`, `tree_status=0`), so the aggregate gate correctly stayed
red. Both hosted jobs completed only their allowed absent-configuration
preflights, and the signed internal APK job was skipped. This run proves the
cross-client clients and orchestration compile and gate correctly; it does not
prove a live hosted handoff.

`feature/chrome-execution-companion` remains unported and tagged as post-beta.
No historical remote branch has been deleted.

## Non-negotiable reconciliation decisions

1. `integration/beta` starts at exactly the verified canonical SHA; no merge was
   used to construct it.
2. No remote branch is deleted until its head has a verified peeling tag, its
   useful work is proven present or deliberately deferred, and this document is
   updated with the replacement commit.
3. Existing migration filenames and contents remain frozen. Any schema repair
   is a new additive migration created with the current Supabase CLI workflow.
4. Canonical shared TypeScript/Kotlin/server contracts win over copied contracts
   on macOS, Telegram, Chrome, or old hardening branches.
5. Synthetic tests can qualify code for hosted testing but cannot establish the
   hosted account-isolation, cross-client, backup, or restore claims required
   for beta release.

## Release blockers at this capture

- Complete-history scanning intentionally remains red for the historical
  Firebase/GCP client key until its Google Cloud disposition and usage review
  are recorded in `docs/security/HISTORICAL_CREDENTIAL_ACTIONS.md`.
- No configured Tsurfing Supabase staging project, Railway staging deployment, or
  two hosted test identities exist yet. The connected unrelated Supabase
  project must not be repurposed.
- Android release signing material and its expected certificate fingerprint are
  absent, so no authorized signed APK exists.
- Telegram remains disabled because no real test bot has completed the live
  webhook/replay/linking/cross-user matrix.
- No staging backup upload and destructive restore drill has run. Synthetic
  crypto and PostgreSQL migration tests are not represented as that proof.

## Personal-beta live continuation — 2026-09-05

After a non-forced full branch/tag fetch, the clean local finalization branch
and its remote both pointed to `a9245b03733334b8be5f5420999862ca32bbdf5f`.
Exact-head run `33958551509` completed success and staging readiness returned
that same revision. Created local short-lived branch
`codex/personal-beta-live-matrix-20260905` from that head for the remaining
Telegram and five-surface staging gates. No merge, rewrite, promotion, tag
creation or preserved-branch deletion was performed.

Created fix/telegram-oidc-callback-20260905 from documentation checkpoint
1126c1c to repair the owner-observed Telegram legacy-widget callback defect.
No integration or production branch has moved. The correction removes the
incorrect client origin parameter; it preserves server-owned OIDC PKCE,
native callback binding and the canonical Supabase account identity.

On source 3ddd52d8c6ac7071e696ffca1f341c64eb3cf41f, fresh owner Telegram OIDC
returned successfully but bot linking rejected the missing signed profile id.
Follow-up correction on the same short-lived branch handles Supabase's nested
custom_claims.id and removes OIDC subject/identity-key fallback. Staging-only
provider allowlist changed from empty to ["id"]; auth identity subject and owner
UUID were retained. Updated readiness records the observed CI overlap and
required fresh authorization. Push this checkpoint only to the existing
finalization branch to avoid duplicate shared-account hosted runs.
