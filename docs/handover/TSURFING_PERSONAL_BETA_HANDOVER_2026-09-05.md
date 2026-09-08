# Tsurfing personal-beta handover — 2026-09-05

## Status at handover

**Staging MVP: operational. Personal beta release: NOT READY.**

The Web/API staging service is healthy on the current runtime candidate. Typed
email OTP, owner TOTP, UUID-scoped authorization, realtime wake-up plus cursor
pull, durable cross-client synchronization, and encrypted destructive restore
have implementation and hosted evidence. Telegram staging infrastructure is
now configured and the real authorization screen is reachable, but the owner
has not completed the Telegram authorization/linking round-trip and the real
Bot/Mini App/five-surface matrix has not run.

Do not advance `integration/beta`, merge `main`, create
`v0.4.0-beta.1`, provision production, or call the beta ready until every
applicable row in `docs/BETA_READINESS.md` is `PASS` on the exact promoted
commit.

This file and `docs/BETA_READINESS.md` are the active stopping record. Use
`docs/handover/LOCAL_CODEX_PERSONAL_BETA_CONTEXT.md` and the runbook for full
requirements; treat older starter/finalization documents as historical where
they conflict with current evidence.

## Exact source and publication state

- Repository: `https://github.com/mariusschober/Tsurfing`
- Local directory intentionally retained: `/Users/schober/Projects/Goalflow`
- Working branch: `codex/personal-beta-finalization-20260904`
- Runtime candidate: `5b7485fd29d6e7c6a894cea272dcd0b435fc5f19`
- Runtime change: supply Telegram's required `origin`, derived from the
  configured Supabase URL, on Web, Android, and macOS without taking ownership
  of OAuth state or PKCE.
- Reviewed source: `44bd85d9662b2e5a9c012b977a26cf4a5c501964`
- Original handover commit:
  `01f864720df7acfa211745e64edec8b5163ab612`, still an ancestor.
- At runtime candidate: 138 commits ahead of `origin/integration/beta`, 51
  ahead of `origin/chore/railway-beta-gate`, and behind neither.
- Draft PR: `https://github.com/mariusschober/Tsurfing/pull/3`
- `main` remains unpromoted and `v0.4.0-beta.1` does not exist.

The documentation-only commit containing this handover is identified by Git
history after this file; the runtime evidence SHA above deliberately remains
stable and independently deployable.

## Verification at the stopping point

Local checks at `5b7485f`:

- `npm run check`: PASS; 58 Vitest files / 315 tests, TypeScript, builds,
  migration/Room ledgers, secret scans, artifact checks, and release contracts.
- Focused macOS email/Telegram auth tests: PASS; 9 tests.
- `git diff --check`: PASS before the runtime commit.
- Local Android rerun: BLOCKED by this Mac having Java 18 while the project
  requires Java 21. A stale local signing-path setting was bypassed only for
  the attempted unsigned check. GitHub's Java-21 Android jobs remain the
  authority; no gate was weakened.

GitHub evidence is recorded with job IDs and artifact digests in
`docs/BETA_READINESS.md`. Exact-head run
`https://github.com/mariusschober/Tsurfing/actions/runs/33957017550` completed
`success` at `5b7485fd29d6e7c6a894cea272dcd0b435fc5f19`: dependency audit, secret scan,
PostgreSQL 17 migrations, verification, Web, both Android gates, macOS, hosted
staging, hosted cross-client, and aggregate `beta-gate` all passed. The Android
internal-beta signing job correctly skipped because signing is deferred and
this is not an `integration/beta` push.

Railway staging:

- Project: `Tsurfing`, ID `58c0b3aa-f2ad-459a-bb6f-194b130c3e68`
- Environment: `staging`, ID `e7ed6925-b96b-4a17-af4e-ae78b2a934fb`
- Web/API service: `tsurfing-web-api`, ID
  `9e949038-a0e4-4aa2-925d-f746ae21ba25`
- Exact runtime deployment:
  `71857011-70b7-4711-8c32-93a25df9e59a`, `SUCCESS`, commit `5b7485f`
- `https://staging.tsurfing.com/api/v1/health/ready`: HTTP 200 with
  `x-tsurfing-revision: 5b7485fd29d6e7c6a894cea272dcd0b435fc5f19`
- Maintenance service remains on its bounded daily schedule with restart policy
  `NEVER`; do not manually execute another restore without a new explicit
  restore target and owner approval.

Supabase staging:

- Isolated free project `Tsurfing Staging`, ref `xyjgpwwvsyjhurkycyqr`,
  `eu-west-1`; Movetrics was not queried or changed.
- All immutable migrations are applied. Hosted PostgreSQL 17 migration, RLS,
  grants, private Realtime topic, two-user isolation, auth, sync, and restore
  evidence is in the readiness ledger.
- Postmark typed-code SMTP is configured; sender is
  `Tsurfing <login@tsurfing.com>`.
- Owner account is `ms@mariusschober.com`, with a verified TOTP factor. Never
  record an OTP, TOTP, session token, SMTP credential, provider secret, bot
  token, webhook secret, backup key, or signing material in chat or Git.
- Turnstile remains disabled and unproven.

## Telegram: exact current state

Staging bot: `@tstagebot`. Production bot reserved: `@tsurfbot`.

Configured in staging:

- Supabase custom provider identifier `custom:telegram`.
- Telegram issuer `https://oauth.telegram.org`, public client ID
  `8300507048`, scopes `openid profile telegram:bot_access`, callback
  `https://xyjgpwwvsyjhurkycyqr.supabase.co/auth/v1/callback`.
- Railway Telegram mode, staging bot username, replacement bot token, webhook
  secret, and provider ID. Retained values were entered directly and are not
  documented.
- Server startup validates the token belongs to `@tstagebot`, registers and
  re-reads the exact webhook
  `https://staging.tsurfing.com/api/v1/telegram/webhook`, configures the Mini App
  menu at `https://staging.tsurfing.com/mini`, and installs the bounded command
  list. Any unverified Telegram acknowledgment fails deployment closed.

Observed but not completed:

- A direct diagnostic proved Telegram rejects the app page as the OAuth
  `origin` but accepts the registered Supabase callback origin.
- Supabase forwarding the accepted origin reached the real
  **Telegram Authorization** page for `TStaging Bot`.
- Do not reuse the old diagnostic URL or its OAuth state. Begin a fresh flow
  from the deployed Tsurfing app.
- No phone number was entered, no Telegram authorization was approved, no
  identity was linked, and neither Bot commands nor Mini App session/SSE were
  live-tested. These remain `NOT RUN`, not inferred successes.

Credential incident disposition:

- The first staging bot token became visible during authenticated UI
  inspection. The owner revoked/rotated it and entered the replacement directly
  into Railway. The replacement value is not in source or documentation. The
  live deployment subsequently validated the replacement against `@tstagebot`.

## Proven product/security work

- Boundary-first Tsurfing rebrand with compatibility-sensitive `goalflow_*`
  storage, protocol, and migration identifiers preserved.
- Typed email OTP request/verification, activation binding, anti-enumeration,
  refresh rotation, restart persistence, logout/revocation, and owner AAL2.
- Web persistence, Android Keystore, and macOS Keychain implementations.
- Explicit Telegram identity linking by immutable provider subject only; no
  merge by email, username, phone, or metadata.
- Payload-free, UUID-scoped Realtime wake-up whose only effect is the existing
  authoritative cursor pull.
- Immediate pull after wake/reconnect/focus/network recovery and foreground
  fallback under 30 seconds; hosted warm p95 below two seconds.
- Durable receipt/cursor/conflict/tombstone/retry/lost-ack protocol retained.
- Web to Android to macOS durable hosted handoff and two-user denial.
- Encrypted backup inspection plus successful destructive restore and canonical
  projection verification.
- Historical Firebase project/key disposition recorded by fingerprint and
  commit-specific scanner acknowledgement; full-history scan green. Firebase
  is not a live dependency.
- TCL T807D physical-device exact-source debug proof. Samsung S23 was not used.

## Remaining work, in safe order

1. Re-fetch all refs, verify the remote branch and documentation head, then
   inspect the newest exact-head GitHub run. Repair real failures without
   weakening or relabeling gates.
2. From `https://staging.tsurfing.com`, start a fresh Telegram sign-in. The
   owner may complete Telegram's authorization screen locally; never ask for a
   phone number, login code, or token in chat. Prove sign-in, explicit linking,
   collision denial, owner AAL2 linking, logout, revocation, and restart.
3. Prove `@tstagebot` webhook commands and the authenticated Mini App
   `initData` cookie/SSE flow. Then run the real Web/TCL/macOS/Bot/Mini App
   five-surface durable-record matrix, including CRUD, duplicate/lost ack,
   conflict, offline restart, reconnect, revocation, and cross-user denial.
4. Configure free Cloudflare Turnstile on Supabase Auth and the server
   preflight, with retained keys entered directly, then repeat typed email OTP
   and abuse/anti-enumeration checks.
5. Repeat the post-restore owner email-OTP plus TOTP journey on Web, TCL and
   macOS. Preserve evidence without recording any code or session material.
6. In about one week, after owner product testing and improvements, perform the
   protected Android internal-beta signing and distributable macOS signing
   gates. Notarization may remain explicitly deferred if the owner chooses.
7. Only after all staging/signing gates pass: pause staging Supabase, confirm it
   is paused, recheck the free-project allowance, and show the owner the exact
   `Tsurfing Production`, `eu-west-1`, `$0` creation summary before creation.
8. Apply migrations to production from scratch, configure distinct retained
   values, deploy the exact proven commit to Railway production, bind
   `app.tsurfing.com`, and run non-destructive production smoke tests.
9. Create/protect `develop`; protect `main` and `integration/beta`; promote only
   via the required green gate. Tag the exact promoted commit
   `v0.4.0-beta.1` and publish verified checksummed artifacts.

## Owner-only checkpoints

Ask for only one action at a time:

- approve a fresh Telegram authorization/linking screen;
- enter retained Turnstile site/secret keys directly in their destinations;
- authorize the external Android signer and macOS Developer ID use after the
  agreed testing week;
- approve creation only after a production project summary explicitly shows
  Ireland / `eu-west-1` and `$0`.

No other owner input is presently required. Movetrics is an absolute
exclusion. Prefer pause over deletion, use only free resources, and stop before
any cost or retained-secret boundary.

## Fresh-session startup

Read in full, in this order:

1. `AGENTS.md`
2. `docs/handover/TSURFING_PERSONAL_BETA_HANDOVER_2026-09-05.md`
3. `docs/BETA_READINESS.md`
4. `docs/handover/LOCAL_CODEX_PERSONAL_BETA_CONTEXT.md`
5. `docs/operations/BETA_RUNBOOK.md`
6. `docs/ACCOUNTS_AND_KEYS.md`
7. `docs/security/HISTORICAL_CREDENTIAL_ACTIONS.md`
8. `DEPLOYMENT.md`

Then fetch without rewriting history, verify branch/remote alignment, create a
tracked Goal, and continue with item 1 of the remaining-work list. Keep the
readiness ledger honest after each narrow pushed checkpoint.
