# Tsurfing personal-beta implementation context

> Active naming and infrastructure update (2026-09-04): Goalflow is now
> Tsurfing. The GitHub repository is `mariusschober/Tsurfing`; the local folder,
> internal Goalflow source namespaces, durable database/storage identifiers,
> migration text, and legacy backup format remain unchanged for compatibility.
> The existing empty Supabase `Tsurfing` project in `eu-west-1` is the staging
> target. Any older statement below that no staging project exists means no
> configured or proven staging environment existed at the handover checkpoint.

**Status:** `NOT READY`

**Captured:** 2026-09-04

> Current-state pointer (2026-09-05): use
> `docs/handover/TSURFING_PERSONAL_BETA_HANDOVER_2026-09-05.md` and
> `docs/BETA_READINESS.md` for the exact GitHub, staging, Telegram, and blocker
> state. The implementation-status sections below remain the original handover
> baseline and requirements contract; they are historical where the current
> handover records later proven work.

**Purpose:** Living handover and execution contract for a local Codex session
finishing the deployed personal beta.

This document separates proven implementation from intended behavior. A test
harness, a compile path, or a configuration preflight is not live release
evidence.

## 1. Outcome

Deliver Tsurfing as a dependable personal beta on Web, native Android, native
macOS, Telegram Bot, and Telegram Mini App. The same Supabase user UUID owns the
same durable data on every surface.

A person must be able to authenticate on the interactive clients with either:

- a typed email one-time code; or
- Telegram's current OIDC Authorization Code flow with PKCE.

While two clients are active and online, committed changes should normally
appear on the other clients within two seconds. A Realtime outage must not lose
data: a 30-second foreground poll plus reconnect, focus, and network-recovery
pulls provide catch-up. Closed or OS-suspended native apps catch up as soon as
the operating system permits them to run. Push notifications may later improve
wake-up latency but can never replace durable pull.

The beta is not complete until authentication, isolation, five-surface sync,
Telegram security, backup/restore, signed artifacts, deployment, and rollback
are demonstrated against the exact released commit.

## 2. Repository checkpoint

At capture time:

| Item | Evidence |
| --- | --- |
| Complete candidate branch | `origin/chore/railway-beta-gate` |
| Candidate/docs head | `01f864720df7acfa211745e64edec8b5163ab612` |
| Tested implementation parent | `7d491c882ccb9e02691e2fe007ee0efce91eceee` |
| Exact-head CI at handover | [Beta Gate run 33823362114](https://github.com/mariusschober/Tsurfing/actions/runs/33823362114) |
| Integration branch | `origin/integration/beta` at `87ae3259de5419c41c3e4add290a889b831f9380`, 86 commits behind the complete candidate |
| Production branch | `main` at obsolete `84bd036ba25d825b5fae36cb780842d9221ed097` |
| Develop branch | Absent |
| Planned first beta tag | `v0.4.0-beta.1`, absent |

The exact-head run passed verification, clean PostgreSQL migrations, the pinned
OSV lockfile audit, Chromium/WebKit release journeys, legacy Android, native
Android tests/lint/build/API-30 installed-upgrade journey, and macOS tests/build.
It failed its aggregate for one deliberately unresolved complete-history
Firebase/GCP credential finding. Hosted staging/cross-client jobs completed
only their explicit unconfigured preflight; Android internal beta was skipped
because the branch was not `integration/beta` and no signer was supplied.

Before starting work, fetch everything and verify ancestry. If the candidate
has advanced, review its diff and exact CI. Never discard newer proven work and
never assume this static checkpoint is still the remote tip.

## 3. What is already implemented and proven

### Shared data and protocol

- Durable local stores and outboxes exist on Web, Android, and macOS.
- Mutations use stable caller-generated UUIDs, exact version/timestamp/device
  receipts, bounded transient retries, and fail-closed permanent failures.
- Cursor pulls, tombstones, deterministic conflicts, cloud conflict ledgers,
  unknown JSON preservation, and task-event traversal have regression tests.
- Web, Room, Swift, server, and PostgreSQL boundaries preserve identifiers and
  numeric/boolean/null distinctions.
- Fourteen immutable migrations apply cleanly to PostgreSQL 16, with a committed
  SHA-256 manifest.
- The Android version-2 database is upgraded in place and checked for exact IDs,
  outbox dependencies, tombstones, timestamps, cursor state, and visible UI.

### Security and lifecycle

- The production server fails closed on incomplete configuration.
- Invite/access approval, profile validation, refresh, revocation, remote
  logout, disabled accounts, safe deletion refusal, and owner TOTP/AAL2 have
  implementation tests.
- Browser and native clients validate both token and usable profile before
  exposing authenticated state.
- Current source and built client artifacts pass secret scanning.
- The dependency audit uses a pinned OSV Scanner action and passed across 749
  lockfile packages.

### Telegram components

- The Bot webhook uses a database-backed processing lease, exact completion
  acknowledgment, duplicate handling, and reclaim-after-expiry behavior.
- The Mini App accepts raw `initData` only from its exact authorization header,
  validates HMAC, freshness, future skew, duplicate fields, and one-time replay
  fingerprints, then issues a short-lived opaque session.
- Mini App operations persist a caller-generated operation UUID across retries.
- Exact Telegram provider identity, active beta profile checks, explicit
  link/unlink, capture confirmation, and cross-user safeguards exist in the
  disabled implementation and tests.
- Telegram remains disabled because it has not passed a real BotFather staging
  matrix.

### Release verification

- Fifty-one Vitest files / 260 tests passed at the tested implementation.
- Eight critical Web journeys passed in Chromium and WebKit.
- macOS ran 176 tests with one explicitly skipped live-staging test, built an
  ad-hoc signed application, verified its signature, and uploaded an artifact.
- Native Android passed unit and instrumentation compilation, lint, production
  debug and unsigned release builds, API-30 UI checks, and the preserved v2-to-v3
  installed-upgrade journey.
- Hosted Web-to-Android-to-macOS harnesses are wired so staging credentials can
  exercise real native transports rather than TypeScript substitutes.

## 4. What is not implemented or not proven

### Authentication gaps

- Web login supports password and a magic-link request. It does not provide a
  field that verifies a typed email OTP. See `components/Auth.tsx` and
  `services/authService.ts`.
- Native Android requests and accepts a PKCE magic-link callback. It has no
  typed email-code verification and no Telegram OIDC flow. See
  `android-native/.../sync/NativeAuthClient.kt` and
  `android-native/.../ui/GoalflowRoot.kt`.
- Native macOS requests and accepts a PKCE magic-link callback. It has no typed
  email-code verification and no Telegram OIDC flow. See
  `macos-native/GoalflowMac/Services/SupabaseAuthService.swift` and
  `macos-native/GoalflowMac/UI/SignInView.swift`.
- Web Telegram OIDC and account-linking scaffolding exists behind flags but has
  not been exercised against a configured provider.
- No Tsurfing SMTP, email template, redirect allowlist, or live staging identity
  exists.

### Realtime gaps

- There is no Supabase Realtime subscription or database wake-up relation.
- Web's visible-page fallback pull runs every 60 seconds in
  `services/cloudSync.ts`.
- macOS's timer pull runs every 300 seconds in
  `macos-native/GoalflowMac/UI/ExecutionPanelView.swift`.
- Android schedules immediate work for local changes but its durable background
  fallback is the WorkManager minimum of 15 minutes in
  `android-native/.../sync/NativeSyncWorker.kt`.
- Bot and Mini App mutations do not wake active Web/native clients.
- Therefore the current product does not provide reliable instant sync.

### Infrastructure and release gaps

- The empty Tsurfing Supabase project had not been identified or configured at
  handover; no isolated production project exists.
- Railway project `58c0b3aa-f2ad-459a-bb6f-194b130c3e68` has only an empty
  `production` environment and no services. The connected tools cannot create
  the missing sibling `staging` environment.
- The only connected Supabase project observed was unrelated `Movetrics`; it is
  explicitly off-limits.
- No Tsurfing staging users, hosted auth/RLS/sync evidence, backup object,
  restore drill, signed Android beta artifact, production service, protected
  branch, or release tag exists.
- One historical Firebase/GCP client key in old history still requires owner
  disposition. The current tree is clean; history scanning must remain red until
  the exact credential is revoked/deleted or appropriately rotated/restricted
  and documented without exposing it.

## 5. Required architecture

### Identity

- `auth.users.id` / the immutable Supabase UUID is the only durable account key.
- Email and Telegram are sign-in identities attached to that UUID, not owner
  identifiers.
- Never auto-link by matching email, Telegram username, phone, display name, or
  mutable metadata.
- Link Telegram only from an already authenticated account or with a short-lived,
  single-use, server-bound linking challenge.
- Active beta profile validation is required on every server request and every
  Bot or Mini App session use. Owner operations additionally require AAL2.

### Email OTP

- Configure the Supabase email template to expose `{{ .Token }}` rather than
  only a confirmation link.
- Request login with `signInWithOtp` and `shouldCreateUser: false`; beta account
  creation remains invite/approval controlled.
- Verify the entered code with `verifyOtp` using the email OTP type.
- Apply rate limits, neutral responses that do not enumerate accounts, resend
  cooldown, expiry handling, bounded attempts, and explicit error states.
- Store sessions in the existing secure per-platform stores. Logout, revocation,
  disabled account, refresh, and damaged-session behavior must retain their
  current fail-closed guarantees.

Official reference:
[Supabase passwordless email login](https://supabase.com/docs/guides/auth/auth-email-passwordless).

### Telegram OIDC

- Configure one staging and one production custom Supabase provider such as
  `custom:telegram` using issuer `https://oauth.telegram.org`.
- Use Authorization Code flow and PKCE S256. Pin exact HTTPS and native deep-link
  callback destinations in both Telegram and Supabase allowlists.
- Treat email as optional. Validate the provider and stable Telegram subject
  before linking it to the Supabase UUID.
- Implement start, callback/state validation, cancellation, replay rejection,
  session exchange, profile validation, and explicit unlink on Web, Android,
  and macOS.

Official references:
[Supabase custom OAuth/OIDC providers](https://supabase.com/docs/guides/auth/custom-oauth-providers)
and [Telegram Login](https://core.telegram.org/bots/telegram-login).

### Realtime wake-up protocol

Keep task data out of Realtime messages. Introduce an additive migration for a
small user-scoped wake-up relation, for example:

```text
sync_wakeups
  user_id        uuid primary key references auth.users(id)
  server_version bigint not null
  updated_at     timestamptz not null
```

The precise shape may change after reviewing the server transaction boundaries,
but these invariants may not:

- Realtime notifications are wake-up hints only; the cursor pull remains
  authoritative.
- one user's subscriber cannot read or infer another user's activity;
- clients cannot forge authoritative versions or write the wake-up directly;
- the wake-up is advanced in the same database transaction that durably accepts
  a mutation, including Bot and Mini App mutations;
- it contains no task content, title, description, schedule, or secret;
- it is only a hint to run the existing authenticated cursor pull;
- duplicates, reordering, and missed messages are harmless;
- no cursor, receipt, outbox entry, or conflict state is advanced from the hint;
- RLS and explicit Data API grants are tested on a hosted project.

Web, Android, and macOS subscribe to their own wake-up state. On notification,
they coalesce concurrent triggers and execute the production sync engine. They
also pull on login, reconnect, application foreground/focus, and network
recovery, with a 30-second foreground fallback. Existing native periodic work
remains the background safety net.

The Mini App may use an authenticated server relay, such as a bounded SSE or
WebSocket channel, if its short-lived opaque session cannot safely authorize a
direct Supabase Realtime connection. The relay must bind the connection to the
linked UUID, revalidate account/session status, emit hints only, enforce origin
and connection limits, and close on revocation/expiry. Never place a server
secret or long-lived Supabase token in the Mini App.

The Bot is request-driven. Its `/current`, `/today`, and confirmation behavior
must read the committed database state and never rely on an in-memory client
cache.

Official references:
[Supabase Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization)
and [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast).

## 6. Execution plan

### Phase A — establish a clean baseline

1. Fetch all branches/tags and verify the candidate is a descendant of the
   evidence base.
2. Review any new remote commits and Actions results.
3. Confirm the worktree is clean and create/continue the short-lived finalization
   branch.
4. Run TypeScript, Vitest, production builds, artifact/secret checks, migration
   manifests, Room manifests, and durable-ID checks.
5. Publish nothing if the baseline introduces an unexplained regression.

Exit: a recorded clean local baseline and a reviewed remote source SHA.

### Phase B — typed email OTP on all clients

1. Add request and verify methods to the Web auth service, including safe resend
   and error-state handling.
2. Add an accessible two-step Web UI: email, then six-digit code.
3. Add native Android request/verify wire models, secure session storage,
   lifecycle-safe ViewModel state, Compose UI, deep-link coexistence, and unit/UI
   tests.
4. Add native macOS request/verify transport, Keychain persistence, UI state,
   callback coexistence, and XCTest coverage.
5. Preserve password/magic-link compatibility only if it does not confuse or
   weaken the intended beta flow. Do not silently create unapproved accounts.
6. Extend hosted browser and native transport tests to prove real code entry,
   expiry, wrong code, resend, refresh, logout, revocation, and disabled account.

Exit: both request and typed verification compile and pass on Web, Android, and
macOS; live proof remains explicitly pending until staging exists.

### Phase C — Telegram OIDC and identity linking

1. Revalidate current Telegram discovery metadata and Supabase custom-provider
   behavior.
2. Finish Web sign-in and link/unlink flows with exact state and callback checks.
3. Add Android PKCE authorization and callback handling without confusing the
   existing email callback.
4. Add macOS PKCE authorization and callback handling with exact URL validation.
5. Reuse server-side provider identity validation and immutable UUID linking.
6. Test forged providers, lookalike subjects, replayed callbacks, duplicate
   identities, disabled profiles, unlink/relink, and revocation.

Exit: implementation tests prove both login methods on all interactive clients;
live provider proof remains pending until staging configuration.

### Phase D — near-instant durable convergence

1. Add the wake-up migration and its hash/manifest evidence. Never alter an
   applied migration.
2. Advance the wake-up in the same accepted-mutation transaction across normal
   sync, Bot, and Mini App writes.
3. Add Web subscription, coalescing, reconnect, focus, network, and 30-second
   fallback behavior.
4. Add Android subscription/lifecycle handling using the production sync engine;
   retain WorkManager as the background fallback.
5. Add macOS subscription/lifecycle handling using the production sync engine.
6. Add the authenticated Mini App relay if required, with expiry/revocation and
   resource-limit tests.
7. Add metrics/logging for connected, reconnecting, last wake-up, last successful
   pull, lag, and terminal auth failure without logging payloads or tokens.
8. Prove message loss, duplication, reordering, reconnect, concurrent triggers,
   account switch, remote logout, server restart, and offline recovery.

Exit: active clients normally converge within two seconds under test; a dropped
Realtime channel is recovered by the authoritative pull and 30-second fallback.

### Phase E — complete repository gates

1. Extend Vitest, PostgreSQL, Playwright, Android, macOS, Telegram, and workflow
   tests.
2. Update hosted orchestration so one durable fixture traverses the real clients
   and cleanup remains fail-closed.
3. Run every local check available.
4. Commit/push isolated checkpoints and use exact-head Actions for the native,
   database, and browser authorities.
5. Record results in `docs/BETA_READINESS.md`; mark live rows `NOT RUN` until
   actual provider/deployment evidence exists.

Exit: all repository-controlled jobs are green except explicitly documented
owner/infrastructure prerequisites.

### Phase F — resolve the historical credential gate

Owner action in Google Cloud project `upheld-flow-201513`:

1. Locate the historical credential without copying it into chat or source.
2. Review usage.
3. Revoke/delete it if unused, or rotate and narrowly restrict it if still
   required.
4. Record only disposition, date, reviewer, and a one-way fingerprint in
   `docs/security/HISTORICAL_CREDENTIAL_ACTIONS.md`.
5. Add an exact-fingerprint allowlist only after the owner action is proven.
6. Rerun the complete-history scanner across all commits.

Exit: the history job is green for the exact candidate without rewriting Git
history or exposing the credential.

### Phase G — create isolated Supabase staging

Owner must confirm the intended organization, region, and exact quoted project
cost before creation. Never repurpose `Movetrics`.

1. Rename the existing empty project to `Tsurfing Staging`, confirm `eu-west-1`,
   and apply the immutable migrations from scratch. Never touch Movetrics.
2. Apply all immutable migrations in order and verify hashes.
3. Configure current publishable/secret keys with correct trust boundaries.
4. Verify explicit Data API grants, RLS, RPCs, triggers, extensions, storage,
   privileged functions, and Realtime authorization.
5. Configure custom SMTP and the typed email OTP template.
6. Configure exact Site URL and Web/Android/macOS redirect allowlists.
7. Configure the Telegram custom OIDC provider.
8. Enable required Realtime behavior for the user-scoped wake-up.
9. Create two synthetic staging users with active beta profiles. Retain passwords
   and identifiers only in the protected CI environment.
10. Bootstrap the owner by immutable UUID and enroll TOTP/AAL2.

Exit: a dedicated staging project passes migration, auth, grant, RLS, isolation,
and Realtime probes.

### Phase H — deploy Railway staging

Owner action: create an empty persistent Railway environment named `staging` in
project `58c0b3aa-f2ad-459a-bb6f-194b130c3e68`. The connected tools could not do
this. Do not clone or modify the empty production environment.

Then:

1. Create `goalflow-web-api` and `goalflow-maintenance` from the same exact
   commit using `.railway/railway.ts`.
2. Supply staging-only origins, Supabase configuration, owner UUID, and backup
   key. Keep Telegram and optional providers disabled initially.
3. Deploy and require `/api/v1/health/live` and `/api/v1/health/ready` to pass.
4. Run the one-shot maintenance command manually before scheduling it daily.
5. Record deployment IDs, URLs, source SHA, configuration names, and redacted
   health evidence.

Exit: staging is deployed from an immutable recorded SHA with no production
changes.

### Phase I — hosted auth, isolation, and five-surface sync

Run with two synthetic users and a unique fixture prefix:

1. User A signs in with an email code on Web, Android, and macOS.
2. User B signs in with Telegram OIDC on the supported clients.
3. Prove refresh, logout, remote logout, expired/malformed/revoked sessions,
   disabled profiles, and owner AAL2.
4. Prove A cannot read, infer, mutate, subscribe to, or delete B's data, and vice
   versa.
5. Run the complete five-surface mutation matrix below.
6. Prove duplicate delivery, lost acknowledgment, deterministic conflict,
   tombstone convergence, offline restart, Realtime disconnect, fallback pull,
   server restart, account switch, and revocation.
7. Delete/tombstone fixtures in a `finally` path and verify cleanup with both
   accounts.

| Writer | Required readers/verification |
| --- | --- |
| Web | Android, macOS, Mini App, Bot `/current`/`/today` |
| Android | Web, macOS, Mini App, Bot |
| macOS | Web, Android, Mini App, Bot |
| Telegram Bot | Web, Android, macOS, Mini App |
| Telegram Mini App | Web, Android, macOS, Bot |

Measure commit-to-visible latency. Record normal and fallback values without
claiming a guarantee the operating system cannot provide to suspended apps.

Exit: every supported create/edit/complete/delete path converges durably and
cross-user attacks fail.

### Phase J — live Telegram staging matrix

1. Create a dedicated staging bot through BotFather.
2. Configure exact staging webhook, webhook secret, Mini App URL, OIDC origins,
   and redirect URLs.
3. Test valid/invalid webhook secrets, duplicate and concurrent updates, lease
   recovery, Telegram API failure, and exact completion acknowledgment.
4. Test fresh/tampered/stale/future/replayed/duplicate-field `initData`, session
   expiry/revocation, and absence of raw credential persistence.
5. Test link, unlink, relink, disabled account, cross-user denial, intentionally
   identical captures, confirmation, and sync wake-ups.
6. Enable `TELEGRAM_ENABLED=true` only after all rows pass.

Exit: the real staging Bot and Mini App pass their security and sync matrix.

### Phase K — backup and destructive staging restore

1. Produce one encrypted staging backup through the deployed maintenance job.
2. Verify object privacy, authenticated metadata, checksum, key availability,
   decryption, and retention behavior.
3. Run and record a dry restore.
4. Create a pre-restore snapshot.
5. Run a destructive restore only against staging test data.
6. Verify row counts, durable IDs, tombstones, outbox/sync state, login, and
   five-surface post-restore convergence.

Exit: recovery is demonstrated, not inferred from backup creation.

### Phase L — signed internal beta and integration branch

1. The owner supplies the externally retained Android signer only through the
   protected GitHub `internal-beta` environment using the five documented secret
   names.
2. Add the required staging public values to that environment.
3. Only after all mandatory staging configuration exists, fast-forward
   `integration/beta` to the proven candidate without rewriting history.
4. Run the mandatory hosted and signing jobs on the exact integration SHA.
5. Verify signer fingerprint, APK SHA-256, provenance, install, login, and sync.
6. Verify the ad-hoc/development-signed macOS beta artifact and record its
   checksum. Notarization may remain post-beta if explicitly documented.

Exit: the exact integration commit has a fully green `beta-gate` and usable
native beta artifacts.

### Phase M — production promotion

1. After staging is proven and confirmed paused, create a completely separate
   Tsurfing Production Supabase project with owner
   approval of organization, region, and price.
2. Apply the identical migration set and configure production SMTP, redirects,
   RLS, Realtime, storage, and a separate production Telegram bot/provider.
3. Configure Railway production services from the same exact commit, with
   automatic production deploy disabled.
4. Replace or close stale PRs only after preserving relevant history and making
   the promotion diff reviewable.
5. Promote the proven history to `main` without force or history rewrite.
6. Require the exact successful `main` push gate, create
   `v0.4.0-beta.1`, and deploy that exact commit manually.
7. Run non-destructive production auth, isolation, health, Telegram, sync, and
   backup smoke checks.
8. Create `develop` from released `main`, connect it to staging auto-deploy, and
   protect `main` and `develop` with the required `beta-gate`.
9. Retain the last known-good deploy for rollback. Delete no preservation branch
   or tag without a separate owner-approved cleanup review.

Exit: production runs the tagged commit and smoke evidence is recorded.

### Phase N — personal acceptance

1. Sign in on Web, Android, and macOS with the intended production identities.
2. Link the production Telegram account and open the Mini App.
3. Create one uniquely named task from each of the five surfaces.
4. Confirm active clients update inside the agreed target.
5. Edit offline on Android, restart, reconnect, and confirm convergence.
6. Exercise a conflict and confirm both copies remain recoverable until an exact
   resolution acknowledgment.
7. Confirm the first scheduled encrypted backup and a recent restore proof.
8. Record APK/macOS checksums, deployed SHA, release tag, and rollback SHA.

Exit: the owner can rely on Tsurfing for daily personal use and the readiness
ledger says `READY` only with links to every required artifact and run.

## 7. Owner-only actions

Ask for these only when the implementation is ready for them:

1. Google Cloud historical credential disposition.
2. Railway dashboard creation of the empty `staging` environment.
3. Supabase organization/region selection and explicit cost confirmation for
   staging, then later for production.
4. BotFather staging/production bot configuration where the connected tool
   cannot perform the action.
5. Externally retained Android signer placement in the protected GitHub
   environment.

Request one precise action at a time. Never ask the owner to paste a secret into
chat, source, documentation, an issue, or an unprotected variable.

## 8. Evidence discipline

For every published checkpoint, record:

- branch and exact commit SHA;
- parent/source SHA and whether ancestry was fast-forward only;
- GitHub Actions run URL and every required job conclusion;
- local command results that are not duplicated by CI;
- exact tested migration and Room hash manifests;
- hosted project/environment identity without secret values;
- deployment and artifact IDs, checksums, signatures, and tested URLs;
- which tests used real Web/Android/macOS/Bot/Mini App implementations;
- every skipped or unconfigured job as `NOT RUN`, never `PASS`;
- the exact owner action for any remaining blocker.

Update `docs/BETA_READINESS.md` after each exact-head run. Update provenance for
branch movement or selective ports. Update the runbook when an operational
procedure changes. Keep this context current when architecture or sequencing
changes materially.

## 9. Final deliverables

- reviewed and protected Git history;
- complete authentication and realtime implementation with tests;
- isolated staging and production projects/environments;
- five-surface live synchronization evidence;
- live Telegram security evidence;
- backup, dry-restore, destructive staging restore, and post-restore evidence;
- signed Android internal-beta APK and verified macOS beta build;
- exact production deployment, smoke evidence, rollback reference, and
  `v0.4.0-beta.1`;
- a readiness ledger with no `BLOCKED`, `NOT RUN`, or misleading preflight rows.

Until all deliverables exist, the only accurate release status is `NOT READY`.
