# Tsurfing owner-trial handover — 2026-09-05

## Start here

Repository: `https://github.com/mariusschober/Tsurfing`.
Local checkout: `/Users/schober/Projects/Goalflow`.
Read `AGENTS.md`, this handover, and the latest section of
`docs/TSURFING_PERSONAL_BETA_IMPLEMENTATION_PLAN_2026-09-05.md` before acting.
This handover supersedes older instructions to autonomously finish every beta
or five-surface gate.

## Owner decision

The owner will use Web and Android intensively for one to two weeks and document
issues for a follow-up next week. Telegram login and chat are in scope. Native
macOS, release signing, and the Telegram Mini App are deferred. Keep testing
minimal: do not resume broad QA, new fixtures, or release work without a new
request. No automatic follow-up has been scheduled.

## Current working state

- Staging: `https://staging.tsurfing.com`, source branch
  `codex/personal-beta-finalization-20260904`, deployed commit
  `d5134d47735c2bfa14359989cf4273a3bdb1a43f`. Final readiness check returned HTTP
  200 and that exact revision.
- Documentation branch: `codex/owner-trial-handoff-20260905`; use this branch for
  the latest handover. It adds documentation only above the deployed source.
- S23: staging-configured native Android debug build installed with existing
  data preserved. APK SHA256:
  `4c56f220dc7be99c36aca04422e61d51384d1e3b3f1c2edf38bce989c2127f5d`.
  This uses the local debug signer, not the deferred release signer. Do not
  replace it with a differently signed CI APK by uninstalling the app.
- Fresh email OTP plus owner MFA succeeded on the S23. Fresh Telegram login
  also returned to native Android after the owner tapped the browser's Open
  app banner. Web Telegram sign-in and owner access were verified.
- Telegram bot `@tstagebot` is linked to the existing owner account. A real
  chat-created task was observed in both Web and Android. No Mini App positive
  authentication test was completed; its first-launch consent was left alone.

## Changes made in this conversation

1. Corrected Telegram OIDC: removed the legacy widget/origin workaround,
   switched staging provider configuration with owner assistance, retained the
   signed Telegram identifier, and completed actual bot binding. Native
   callback allowlisting now covers the generated state query.
2. Added server CAPTCHA-policy discovery and corrected Android's unconditional
   CAPTCHA requirement. Server-side verification remains authoritative.
3. Fixed Android sync discarding the signed-in session on `mfa_required`.
   Owner verification can now finish without being signed out by background
   sync. Other authorization failures still fail closed.
4. Replaced Android's blocking generic conflict prompt with an item-specific
   review, actual differing field values, explicit deletion choices, and
   Review later. Exact server-acknowledgment semantics are unchanged. Added a
   clear instruction for the Telegram browser-to-app return.
5. Equivalent macOS CAPTCHA/MFA fixes are preserved separately at commit
   `2378b18` on remote branch `codex/deferred-macos-auth-20260905` (local branch
   `fix/macos-auth-policy-20260905`). They are not deployed to staging. The Mac
   has zero valid signing identities; live secure Keychain behavior remains
   unproven. Do not promote this branch as a tested distributable Mac build.

## Evidence and honest limits

- Android: 128 unit tests passed, one hosted test skipped locally. Web/server:
  all 333 tests passed. Builds and required integrity checks passed.
- Prior deployed revision `69a67fb` completed all applicable CI successfully:
  https://github.com/mariusschober/Tsurfing/actions/runs/33995598797 .
- Current revision CI was still running at handover:
  https://github.com/mariusschober/Tsurfing/actions/runs/33997186165 .
  Check its actual outcome before claiming it passed; no watcher is running.
- Deferred Mac code: 194 tests passed, one hosted test skipped. Tests use an
  injected Keychain backend where signing is unavailable.
- Earlier hosted evidence covers isolation/RLS, exact acknowledgments,
  conflict/tombstone behavior, cross-client transport, backup and destructive
  restore. That is not proof of every physical-device or owner journey.
- The new Android conflict dialog has unit/build coverage but has not been
  visually exercised with a new live conflict. Broad restart/offline/reconnect
  checks were stopped at the owner's request.

## Known issues and next session

- Telegram login may require manually tapping Open app; automatic return is
  not guaranteed. The installed Android build now explains it.
- The owner's chat message “Tsurfing testing for 30 minutes today” became a
  task whose title includes “30 minutes” but whose duration is 25 minutes.
  Preserve the task; duration parsing needs review if the owner reports it.
- Two confusing prompts came from old restore-test sentinel history, not a
  newly lost owner task. With explicit permission, both were resolved through
  normal cloud-version acknowledgments. No unresolved copies of those two
  test conflicts remained. Do not clear databases or outboxes to hide errors.
- Next work should begin with the owner's issue log, prioritize reproduced
  failures, and perform only proportionate checks. Keep stable IDs, pending
  mutations, local data, and existing credentials intact.
- Release remains NOT READY: Turnstile, signed artifacts, deferred platform
  journeys, broader owner-device convergence, isolated production setup,
  promotion/protection and the release tag remain open. Do not touch Movetrics,
  `main`, `integration/beta`, production, signing or `v0.4.0-beta.1` without the
  corresponding explicit authorization and gates. Use only free resources.

All credentials, OTPs, MFA seeds and private signing material stay in their
intended local/secure stores. This handover intentionally contains none.
