# Automatic sync recovery — 7 September 2026

The owner requested cloud-authoritative, automatic reconciliation instead of manual conflict review, and reported Android numbering beginning at 2 plus misleading local-only ordering feedback.

## Shipped implementation

- Source: `b2a1deea3c350ead18dd0bfc92632c13d865255f`, branch `fix/cloud-authoritative-sync-20260907`, promoted to `codex/personal-beta-finalization-20260904`.
- Staging web/API deployment: Railway `f76d0536-2f0b-4bc3-8711-16f5537b0798`, **SUCCESS**, exact source above.
- Forward database migration: `202609070002_automatic_sync_reconciliation.sql`; hosted migration `20260907105753`, `automatic_sync_reconciliation`.
- Native Android staging debug APK SHA-256: `be2a4090b8eb3f61c277bb8d202f56d3b8b68ac7d5bb3288a8ac83557298946f`. Installed with an in-place update on the attached TCL T807D; app data and login retained.

Version mismatches are now reconciled automatically by a server operation under the entity lock. The original edit timestamp selects between differing copies; the cloud wins ties, and a missing item is added. Existing immutable task events remain authoritative. A far-future device timestamp cannot displace an existing cloud copy. Seeding an old web cache preserves its source timestamp, or uses an unknown/old baseline, rather than inventing a new edit at login.

Every automatic operation stores the complete submitted local history and previous cloud record in the existing durable mutation ledger. Original mutation IDs, request fingerprints, and receipts are not rewritten. Retries return the current canonical cloud record. Web and Android verify the exact candidate acknowledgment and cloud identity/revision before atomically applying it. Edits queued while reconciliation is in flight stay visible and pending.

Manual-review banners were replaced with automatic-sync status and retry controls. Nested Android review data is no longer serialized as raw JSON. Planning now numbers the displayed queue from 1, including when a priority task precedes its stored numeric position. Reordering already queued durable mutations and reached the cloud; its misleading “locally” snackbar was corrected.

## Verification

- Web/server `verify:release`: **PASS**, 356 tests across 63 files; type check, production build, client secret/artifact checks, server and maintenance checks passed.
- PostgreSQL: **PASS** on clean and upgrade databases, including original-receipt preservation, older/newer edits, cloud timestamp ties, missing records, idempotent retries, current-record replay, and future-clock handling. Existing isolation, RLS, replay, backup/restore, and migration suites remained green.
- Migration hashes, Room hashes, durable identifiers: **PASS**.
- Android: all four debug/release production/sandbox unit-test variants passed (133 tests per variant, one explicitly skipped hosted transport test in each; zero failures/errors). Production-debug lint and APK assembly passed.
- Physical TCL after installation: **0 conflicts, 0 pending outbox entries**; Planning visibly starts at **1**, then **2**. No owner task was edited for this check.
- Real Brave staging browser: the prior twelve local conflict prompts disappeared through automatic sync, and the UI reported **Synced**. Server evidence showed **0 unresolved conflicts** and **15 audited automatic reconciliations** after web and TCL recovery.
- A rollback-only rehearsal against the three then-unresolved server event conflicts succeeded before the updated clients were activated.

## Earlier web focus fix

Source `35cda299d38eafb706f6680981d25845daf5cd0b` preserves the mounted app during revalidation of the same authentication session. Ten Chromium/WebKit regression cases passed, covering repeated sign-in events, token refreshes, transient failures, revocation, new-login MFA, assurance downgrade, and sign-out races. Four unit cases verify session identity continuity.

After activating the final staging build, a real unsaved task draft in Planning survived opening a second Tsurfing browser tab and returning. Dismissing only that temporary draft left Planning open. The temporary tab was closed, and no test task was saved. The goal-entry form was not separately exercised live because the owner's overdue-work gate disabled Goals; the same app-mount fix covers its parent lifecycle.

## CI boundary

Current fix CI: https://github.com/mariusschober/Tsurfing/actions/runs/34114235369 — running at the live recovery checkpoint. Do not call all hosted gates green before this run completes.

The preceding focus-fix run, https://github.com/mariusschober/Tsurfing/actions/runs/34111872068, passed web-release, verification, migrations, secrets, dependency audit, macOS, and Android jobs at inspection, while native Android remained running. Its hosted-staging browser job failed after HTTP 429 on sync pull prevented the expected cross-browser convergence within ten seconds. This is not a public-release readiness claim.
