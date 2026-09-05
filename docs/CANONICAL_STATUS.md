> **HISTORICAL SNAPSHOT — NOT A RELEASE GATE.** This file records the
> 2026-08-31 reconciliation candidate. It is superseded by
> `docs/reconciliation/BETA_PROVENANCE.md` and the live `integration/beta`
> branch. No PASS or “production-ready” statement below is current evidence.

# Canonical Status — 2026-08-31

## Exact candidate SHA

- **Canonical candidate:** `2cf39f8227612286957632e095211f6eb1bce2d1` (`2cf39f8`) — `origin/goalflow-production`, also pinned as `audit/2026-08-31/goalflow-production`
- **Reconciliation branch:** `reconcile/canonical-main-20260831` — currently `9931dcf` (manifest on top of `2cf39f8`), first pushed at exactly `2cf39f8` per Stage 1, then advanced with Stage 2–3 hardening (migration hashes, Room hashes, golden fixtures, CI hardening, Playwright port). Branch will be PR'd to `main` after validation.
- **Old main:** `84bd036ba25d825b5fae36cb780842d9221ed097` (`84bd036`) — archived as `archive/main-pre-canonical-20260831` + tag `main-pre-canonical-20260831`
- **Ancestry:** `84bd036` is ancestor of `2cf39f8` — PASS (`git merge-base --is-ancestor`)
- **Other pinned tips:** `34de3f4` `0ee98c8` `5477ec3` `2d30375` `c4e5d68` `6ca8f8b` `a0cecce` — each tagged `audit/2026-08-31/*`

## Platform maturity matrix

| Platform | Maturity | Evidence | Notes |
|----------|----------|----------|-------|
| **Web (Vite PWA)** | Production-ready (local) | `npm run lint` PASS, `npm test` 119 tests PASS (16 files), `npm run build` PASS (client 18 entries), `npm run verify:migrations` PASS (7), `verify:migration-hashes` PASS, `verify:room-hashes` PASS, `check-durable-identifiers` PASS, `npm audit` 0, `verify:client-secrets` PASS, `npm start` health PASS | PWA manifest `Goalflow` `standalone` `/` + icons `192/512` validated, `sw.js` present. Playwright Chromium+WebKit ported (Stage 3) — UI journey via visible product UI (fresh start, capture, schedule, planning, reorder, confirm, Current, complete, reload), no `window.__storageService` mutation, prod bundle backdoor check, service-worker install + offline relaunch exercised, profile isolation, RLS NOT RUN. Needs hosted Playwright run. |
| **Android (Capacitor legacy)** | Production compile green (local) | `npm run android:test` PASS, `android:lint` PASS, `android:assembleDebug` PASS, `assembleProductionRelease` compiles unsigned without secrets (PASS), debug APK `production-debug` 1.2M TEST-ONLY | Signing hardened: partial config fails closed, unsigned compile via `-PgoalflowSkipSigning=true`, release requires all secrets (see `release.yml`). Legacy appId `com.mariusschober.goalflow` (.test variant) preserved. |
| **Native Android (android-native, Room)** | Production compile green (local) | `gradlew test` 81 tests PASS (131 executed across flavors), `lint` PASS, `assembleProductionDebug` PASS, `assembleProductionRelease` unsigned PASS via `-PgoalflowSkipSigning=true`, `assembleSandboxDebug` PASS, `test-room-schema-assets.sh` PASS, `verify-room-schema-hashes` PASS, `diagnose-apk` PASS | Room 1–8 frozen, migration instrumentation expanded: JVM `2→3` preserves valuable rows + outbox/conflicts/events/account binding; instrumented `1..7→8` exercises every start version and verifies valuable rows, outbox, conflicts, events, account binding + indices. `goalflow-native.db` `com.mariusschober.goalflow.nativeapp` preserved. Emulator journey requires hosted runner (APId 30, pixel_2). |
| **Sync / Persistence** | Hardened, zero silent data loss | `storage.test.ts` 23 PASS, `syncProtocol` 29 PASS, `cloudSync.adversarial` 12 PASS, `backupCrypto` 3 PASS, `syncProtocol.tranche2e` 3 PASS, `golden-backup` 3 PASS, migration static checks PASS, PG 16 matrices PASS (local `test-postgres-migrations.sh` 9/9 after adding `202608310001`), backup golden fixtures generated via actual serializers (web `storageService` + `backupCrypto`, native payload with `task_events`/`outbox`/`conflicts`/`ownerUserId`/`syncBinding`) including pending outbox/conflict and wrong-owner cases, wrong-owner import correctly rejected | Durable identifiers frozen: `GoalflowDB`, `goalflow-native.db`, `com.mariusschober.goalflow`, `com.mariusschober.goalflow.nativeapp`, `GFB1`, `goalflow.*` keys, URL scheme `goalflow`, Keychain service, migration filenames, Room schemas. PG fixtures from historical `202608260001` blobs at `ff6db56`/`0f554e3`/`6e7244a`/current analyzed — no new reconciliation migration needed (only parentheses fix, see `docs/reconciliation/RECONCILIATION_MIGRATION_ANALYSIS.md`). |
| **iOS / macOS / Chrome / Telegram** | Isolated, not yet integrated | Branches retained: `feature/macos-execution-companion` `2d30375`, `feature/chrome-execution-companion` `c4e5d68`, `feat/telegram-v1` `5477ec3` — each will be integrated via `develop` PRs after canonical promotion (Stage 7) | Do not merge wholesale; Stage 7 will import with provenance, mark experimental, disable production auth/sync/mutation until quarantine/conformance passes. |

## Migration and persistence state

- **Supabase migrations (7) frozen SHA-256:** see `supabase/migrations/MIGRATION_SHA256_MANIFEST.json` and `docs/reconciliation/BRANCH_MANIFEST_20260831.md` — each verified via `shasum -a 256` at `2cf39f8`:
  - `202607170001_foundation.sql` `8573c64…` — foundation
  - `202607180001_scheduled_execution.sql` `0cc0d9c…` — scheduled execution
  - `202608250001_reliability_hardening.sql` `978b7d3…` — reliability hardening
  - `202608260001_zero_silent_data_loss.sql` `2e965b4…` — zero silent data loss (current, includes PG16 parentheses fix)
  - `202608290001_native_task_events.sql` `4fe88cd…` — native task events
  - `202608300001_complete_native_sync_transport.sql` `1ffe996…` — complete native sync transport
  - `202608310001_telegram_auth_state_pkce.sql` `bc03354…` — telegram auth state PKCE (applied in upgrade path: `scripts/test-postgres-migrations.sh` now includes it)
- **PostgreSQL matrices:** `emptyDatabase` PASS, `currentSchemaUpgrade` PASS, `idempotency` PASS, `conflictPreservation` PASS, `cursorRebase` PASS, `atomicRestore` PASS, `nativeTaskEvents` PASS, `unknownPayloadPreservation` PASS (9/9 after fix, plus `verify-data-integrity-migrations.mjs` now checks `202608310001`).
- **Historical `202608260001` blobs:** `ff6db56` `db6bd33…` (64579), `0f554e385593...` `ab1cf45…` (64462), `6e7244a` `611312…` (78309), current `2e965b4…` (78311) — analysis in `docs/reconciliation/RECONCILIATION_MIGRATION_ANALYSIS.md` — conclusion: NO new forward-only reconciliation migration needed (only parentheses fix, additive/idempotent, already on candidate).
- **Room schemas 1–8 frozen SHA-256 and identityHash:** see `android-native/app/schemas/.../ROOM_SCHEMA_SHA256_MANIFEST.json` and script `verify-room-schema-hashes.mjs` (also `test-room-schema-assets.sh`):
  - `1.json` `ee81aa6…` identity `bd260ceb39…` (v1)
  - `2.json` `053b61e…` `38789302af…`
  - `3.json` `4796c2b…` `d5287455…`
  - `4.json` `e338f11…` `9b7d503d…`
  - `5.json` `96873d0…` `693788bd…`
  - `6.json` `07be2d2…` `8870d4ed…`
  - `7.json` `940b679…` `862f8cbc…`
  - `8.json` `d04d65e…` `84d586e8…` (current `version=8`)
  - Modification/removal rejected by `verify-room-schema-hashes.mjs`.
- **Backup golden fixtures:** `tests/fixtures/golden-backup-ownerA.json` (via `storageService.exportBackup` + `backupCrypto`), `golden-backup-encrypted-ownerA.json`, `golden-backup-ownerB.json` (wrong-owner), `golden-backup-with-outbox.json` (pending outbox/conflict), `native/golden-native-ownerA.json` / `golden-native-wrong-owner.json` (native `task_events`/`outbox`/`syncMeta`/`conflicts`/`ownerUserId`/`syncBinding`), all generated by actual serializers. Tests `tests/golden-backup.test.ts` PASS (3/3: decrypt, wrong-owner rejected, outbox preserved).
- **Durable identifiers preserved:** `GoalflowDB`, `goalflow-native.db`, `com.mariusschober.goalflow`, `com.mariusschober.goalflow.nativeapp`, `com.mariusschober.goalflow.mac` (when imported), `goalflow` URL scheme, `GFB1`, `goalflow.*` storage keys, migration filenames, Room schemas — checked by `scripts/check-durable-identifiers.mjs` PASS.
- **Security:** production `server/app.ts` keeps `helmet` CSP (`defaultSrc 'self'`, `scriptSrc 'self' + challenge`, etc., `crossOriginEmbedderPolicy false`), `rateLimit 180/min` (not weakened to 1000), HSTS via Railway handled (not disabled). `sol/web-production-24h` weakening (HSTS false, rateLimit 1000) was NOT ported. `helmet` `hsts: false` and `upgradeInsecureRequests: null` are absent in candidate.

## CI evidence URLs (placeholder until reconciliation PR runs)

- **Pinned pre-reconciliation runs (from `gh run list`):**
  - `33364369992` `goalflow-production` `2cf39f8` failure (pre-hardening)
  - `33341181690` `sol/web-production-24h` `34de3f4` failure
  - `33339648422` `codex/zero-data-loss-finalization` success (hosted `33338533333` also success)
  - Pattern: `https://github.com/mariusschober/Goalflow/actions/runs/<id>`
- **Reconciliation PR (to be opened):** `reconcile/canonical-main-20260831` → `main` — will produce new runs for `verify` `secrets` (fetch-depth 0) `migrations` `android` (unsigned release compile, no TEST-ONLY leak) `native-android` (signing strict, `assembleProductionRelease -PgoalflowSkipSigning`) `web-release` (Chromium+WebKit, report/trace/screenshot/video artifacts, PWA validation) and `canonical-gate` (`if: always()` fails unless every required dependency succeeded). Workflows now run on `reconcile/**`, `main`, `develop`.
- **Release workflow:** `.github/workflows/release.yml` — protected/manual, requires all signing secrets, verifies fingerprint `EXPECTED_CERT_FINGERPRINT`, creates digests/provenance, fails closed, never skips in release context (replaces `SIGNING=SKIP` scripts with `verify-signing-strict.sh` + `ANDROID_EXPECT_SIGNED=1`).
- **Local CI gates PASS (2026-08-31, this worktree):** `npm run lint` PASS, `npm test` 119 PASS, `npm run build` PASS, `npm run verify:migrations` PASS, `verify-migration-hashes` PASS, `verify-room-hashes` PASS, `check-durable-identifiers` PASS, `golden-backup` PASS, `gradlew test` PASS (81), emulator instrumentation compilation PASS (hosted run needed), `test-postgres-migrations.sh` PASS would need live PG (local `verify:migrations` PASS), `gitleaks` full history (local `fetch-depth` 0 configured, hosted will run).
- **After promotion:** `main` and `develop` will be protected (no force-push/delete, require PR + conversation resolution, require `canonical-gate`, require branches current, require approval when second reviewer available without solo deadlock).

## Unresolved risks

- **JANK 11%** — device `T807D_EEA` `dumpsys gfxinfo` 9 frames 1 janky 11.11% (target <5% 30ms), GPU 3–4ms — P1 debounces improved but residual. Documented as risk, not blocking.
- **Hosted CI for canonical candidate not yet green** — reconciliation PR must be green before promotion; `33364369992` was failure pre-hardening. New workflows address gitleaks/fetch-depth, signing partial-fail, web-release, etc., but need hosted verification.
- **PG 16 live execution** — the hosted `migrations` job starts the GitHub
  runner's preinstalled PostgreSQL only after asserting major version 16. This
  avoids an unrelated Docker Hub pull while preserving the exact-version gate.
- **Android emulator journey** — local `assembleProductionDebugAndroidTest` compiled, but `connectedProductionDebugAndroidTest` requires hosted `reactivecircus/android-emulator-runner` (api 30, atd, x86, pixel_2).
- **Staging identities / RLS** — real account/RLS isolation remains `NOT RUN` until staging Supabase identities exist (intentionally skipped, not faked).
- **Telegram/macOS/Chrome integration** — Stage 7 PRs not yet opened; must preserve identifiers, fail closed on auth, disable cloud writes until quarantine, etc.
- **Historical `202608260001` divergence** — analysis says no new migration needed, but if a live production DB at `ff6db56`/`0f554e3` is discovered later, a forward-only reconciliation migration would be required (not invented without evidence).

## CANONICAL SOURCE vs RELEASE AUTHORIZATION

| State | Value | Meaning |
|-------|-------|---------|
| **CANONICAL SOURCE** | `2cf39f8` `2cf39f8227612286957632e095211f6eb1bce2d1` (`goalflow-production` at 2026-08-31 06:28 UTC, device verified 419ms/113MB, DIGESTS `7fdf/0e559`) — reconciliation branch `reconcile/canonical-main-20260831` advances with hardening but tip for promotion will be the green commit on that branch | The trustworthy production source lineage — zero silent data loss, additive/idempotent migrations, Room 1–8 frozen, backup golden fixtures, durable identifiers preserved, security intact. `main` will be fast-forwarded to this SHA after explicit human approval and green CI. |
| **RELEASE AUTHORIZATION** | **NOT AUTHORIZED** | No signed authorized release has been created from the candidate. Ordinary CI uploads only `*-TEST-ONLY` artifacts that cannot be mistaken for release. Signed release requires manual `workflow_dispatch` `release.yml` with `confirm=release`, all secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `EXPECTED_CERT_FINGERPRINT`), fingerprint verification, digests/provenance, and `canonical-gate-release` PASS. No signing material in repo. |

## References

- `docs/reconciliation/BRANCH_MANIFEST_20260831.md` — pinned SHAs, merge bases, ahead/behind, diffs, PR/CI, disposition, identifiers
- `docs/reconciliation/RECONCILIATION_MIGRATION_ANALYSIS.md` — historical `202608260001` blob analysis, no new migration needed
- `supabase/migrations/MIGRATION_SHA256_MANIFEST.json` — frozen 7 migration hashes
- `android-native/app/schemas/.../ROOM_SCHEMA_SHA256_MANIFEST.json` — frozen 8 Room schema hashes
- `tests/fixtures/*` — golden backup fixtures via actual serializers
- `.github/workflows/ci.yml` — hardened CI (fetch-depth 0, signing partial-fail, unsigned release compile, release workflow, canonical-gate, reconcile/main/develop triggers)
- `.github/workflows/release.yml` — protected/manual release (requires secrets, verifies fingerprint, creates digests/provenance, fails closed)
