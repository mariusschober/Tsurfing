# Tsurfing personal-beta implementation plan — 2026-09-05

Status: IN PROGRESS. Release remains NOT READY.

## Verified baseline

- Working branch: `codex/personal-beta-live-matrix-20260905`, created from clean
  `a9245b03733334b8be5f5420999862ca32bbdf5f` after fetching all branches and tags.
- Local and remote finalization heads match. Original evidence commit
  `01f864720df7acfa211745e64edec8b5163ab612` remains an ancestor.
- Changes since runtime `5b7485f` touch documentation only.
- Exact-head run: https://github.com/mariusschober/Tsurfing/actions/runs/33958551509
  completed success; hosted-cross-client job `101289455020` and aggregate
  beta-gate `101290231834` passed. Android signing correctly skipped.
- Staging readiness returned HTTP 200 at 2026-09-05 11:07 UTC with revision
  `a9245b03733334b8be5f5420999862ca32bbdf5f`.
- Release tag `v0.4.0-beta.1` remains absent.

## Execution sequence and evidence requirements

1. **Baseline — PASS.** Retain exact source, ancestry, CI results and deployment
   revision. Review existing app updates before asserting browser code parity.
2. **Fresh Telegram authorization/linking — IN PROGRESS.** Start from deployed
   app, preserve immutable owner UUID, verify AAL2, and hand off provider consent
   to owner locally. Prove successful return, explicit bot binding, logout,
   fresh Telegram sign-in, restart, unlink/relink and revocation. Never retain
   authorization URLs, OAuth state, phone numbers, login codes or session values.
   Use separate controlled identities for collision denial; do not change owner
   authorization to manufacture an isolation test.
3. **Bot/Mini App live proof — NOT RUN.** Use only @tstagebot. Exercise commands,
   capture confirmation, duplicate/lost acknowledgments and committed reads.
   Open Mini App through Telegram and prove authentic initData, cookie session,
   bounded SSE, expiry and revocation. Synthetic signatures are not live proof.
4. **Five-surface matrix — NOT RUN.** Use uniquely named disposable staging
   fixtures. Each Web/TCL Android/macOS/Bot/Mini App writer must converge to all
   four readers through their real implementations. Record supported CRUD,
   completion, durable IDs, exact acknowledgments, conflicts/tombstones,
   online latency, reconnect/fallback, offline restart and cross-user denial.
   Clean up only these fixtures with normal tombstones and verify propagation.
5. **Turnstile — PENDING OWNER INPUT.** Prepare free configuration, have owner
   enter retained keys directly, then test email OTP and neutral abuse responses.
6. **Post-restore owner journeys — NOT RUN.** Repeat typed email OTP plus TOTP on
   Web, TCL and macOS and prove fresh/offline-client convergence. Existing AAL2
   session persistence does not replace a fresh post-restore OTP journey.
7. **Checkpoints.** Fix observed defects with focused regression tests, then run
   required release checks and exact-head CI. Publish isolated proven branch
   checkpoints and update readiness/provenance with precise evidence and gaps.

## Boundaries

Movetrics is excluded from all reads and writes. Use only free resources; stop
before cost. Secrets stay in their intended local forms or protected stores.
Ask for one owner action at a time. Preserve outboxes, conflicts, durable IDs,
immutable migrations and existing device data. No new destructive restore is
allowed without an explicit target and owner approval.

Android and macOS release signing are deferred about one week for owner product
testing. Keep integration/beta, main, production and v0.4.0-beta.1 untouched.
Production creation, promotion and signing are future gated work, not part of
this staging checkpoint. No staging pass by itself authorizes release.

## Live observations

- The browser retained the owner account; loaded security settings showed
  authenticator Active (aal2) and Telegram Not linked.
- A pending app-update banner was visible. The initial fresh link attempt hit
  Telegram `origin required`; current server revision alone does not prove the
  cached browser bundle was current. Apply the pending update and repeat from
  the app before classifying the defect.
- An existing sync-conflict indicator was visible; no conflict was discarded or
  resolved as part of setup.

- Returning to staging removed the pending-update banner. A new linking attempt
  reached the real Telegram Authorization page for TStaging Bot. Owner local
  phone entry and consent requested; completion remains pending.
- Focused handover/account-link/Mini App authentication checks: 4 files, 23 tests
  passed. Android device inventory is currently empty, so physical TCL proof is
  waiting for device connection; no other device was selected or modified.
- Local Java inventory still exposes Java 18 only. Native Java-21 CI remains
  the verified authority; local release signing was not attempted.
- Local baseline `npm run check`: PASS, 58 test files / 315 tests, TypeScript,
  client/Mini App/server builds, client secret scan and artifact checks.
- Remaining release checks: server and maintenance fail-closed probes PASS;
  migration static verification PASS; all 18 migration and 8 Room hashes PASS;
  all 20 durable identifier checks PASS. These complement the successful
  npm run check and do not replace the exact-head hosted/native evidence.

- 11:15 UTC: six live unauthenticated Bot/Mini App rejection cases PASS, each
  HTTP 401 with the expected error and no session cookie. Readiness immediately
  afterward remained HTTP 200 at a9245b0. Authorized journeys remain NOT RUN.
- Telegram remains on its provider authorization page. The owner checkpoint is
  unchanged; no credentials or consent were supplied by the agent.
- Documentation-only continuation branch pushes do not trigger CI under current
  workflow filters. Do not confuse their local checks with a new hosted run.

## Corrected Telegram execution path

The first owner authorization proved a real defect: legacy widget result at the
Supabase root, not an OIDC code at /auth/v1/callback. The origin workaround is
invalid and is removed on fix/telegram-oidc-callback-20260905. BotFather was still
in legacy mode; owner has switched staging bot to OIDC. Register the exact
Supabase Redirect URI, enter the OIDC-specific secret directly into Supabase,
then publish the corrected exact source to staging and start fresh linking.
Never accept the old widget result as an account identity or fabricate a
callback from it. Runtime regression checks: Web 3 new behavior cases (red
before fix, green after), Android auth 29/29, macOS auth 9/9; full npm check
318 tests PASS. Java 21 is installed under Homebrew even though java_home
listed only Java 18.

## Owner-away checkpoint

OIDC return now PASS on the existing owner UUID; bot binding remains BLOCKED
on a fresh authorization after allowing the signed profile id through Supabase.
The server consumes custom_claims.id and never substitutes the opaque subject.
Full check 332 tests PASS. See the active readiness ledger for claim-loss,
configuration and CI-overlap evidence. Owner left the desk and authorized all
independent work, then a pause at the next owner-only dependency. Preserve the
session and leave the next step ready; do not fabricate a binding.
