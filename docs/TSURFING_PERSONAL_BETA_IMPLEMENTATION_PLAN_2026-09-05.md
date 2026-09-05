# Tsurfing personal-beta implementation plan — 2026-09-05

Status: OWNER TRIAL — additional testing paused at the owner's request. Release remains NOT READY.

## Latest owner decision — 2026-09-05

Use Web and Android intensively for one to two weeks. Telegram login and chat
remain in scope; Mini App and native macOS/signing are deferred. Keep testing
minimal and review the owner's documented issues next week. Do not execute the
older five-surface sequence below automatically; it is retained as deferred
release work, not tonight's instruction.

Current installed Android/staging source: `d5134d47735c2bfa14359989cf4273a3bdb1a43f`.
Staging returned HTTP 200 with that exact revision at handoff. The S23 received
the staging-configured local-debug APK with data preserved; SHA256
`4c56f220dc7be99c36aca04422e61d51384d1e3b3f1c2edf38bce989c2127f5d`.
This is not the future signed internal-beta artifact.

Fresh S23 email OTP plus owner MFA succeeded after preserving sessions awaiting
MFA. Fresh Telegram sign-in returned to native Android via the browser's manual
Open app banner; automatic return is not proven. The new build explains that
return step. A real Telegram chat capture was observed in Web and Android.
Two old restore-sentinel conflicts were explicitly resolved via normal cloud
acknowledgments with owner approval. The Android update adds item/field-level
conflict explanations and Review later; its actual conflict-dialog visual QA
remains unperformed because the owner requested minimal testing.

Local checks: 333 web/server tests passed; Android 128 passed and one hosted
case skipped. Required static integrity and build checks passed. Prior revision
`69a67fb652b12552c3808c5b5d49aa78c8f2c969` CI completed successfully:
https://github.com/mariusschober/Tsurfing/actions/runs/33995598797 .
Current revision CI was still in progress at handoff:
https://github.com/mariusschober/Tsurfing/actions/runs/33997186165 .
Do not represent its status as passed without checking it again.

Tested macOS CAPTCHA/MFA fixes are preserved locally on
`fix/macos-auth-policy-20260905`, commit
`2378b18` (194 tests passed, one hosted case skipped), and are not included in the
staging push. This Mac has zero valid code-signing identities; live secure
Keychain proof and distribution signing remain deferred.

Remaining release gates include Turnstile, broader physical offline/reconnect
and convergence checks, deferred Mac/Mini App journeys, signed artifacts,
isolated production configuration/deployment, and protected release promotion.
No production, main, integration/beta or release tag was changed.

---

The following is historical execution context; latest owner scope above prevails.

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
