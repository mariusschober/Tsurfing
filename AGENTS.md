# Tsurfing repository instructions

## Read this first

For personal-beta work, read these files in order:

1. `docs/handover/LOCAL_CODEX_PERSONAL_BETA_CONTEXT.md`
2. `docs/BETA_READINESS.md`
3. `docs/reconciliation/BETA_PROVENANCE.md`
4. `docs/operations/BETA_RUNBOOK.md`
5. `docs/ACCOUNTS_AND_KEYS.md`
6. `docs/security/HISTORICAL_CREDENTIAL_ACTIONS.md`

`docs/handover/LOCAL_CODEX_START_PROMPT.md` is the active copy/paste prompt for
a fresh local Codex session. The other files named `STARTER_PROMPT*` are
historical snapshots and must not be executed.

## Current source of truth

- The active finalization source is
  `origin/codex/personal-beta-finalization-20260904`, based on the reviewed
  `origin/chore/railway-beta-gate` tip
  `44bd85d9662b2e5a9c012b977a26cf4a5c501964`.
- The original handover evidence base remains commit
  `01f864720df7acfa211745e64edec8b5163ab612` and must remain an ancestor.
- A newer tip is acceptable only after reviewing its diff and CI and proving it
  is a descendant of that evidence base.
- `integration/beta` is currently 86 commits behind the evidence base. Advance
  it only when staging and signing prerequisites exist and its mandatory CI can
  run honestly.
- `main` is obsolete and must not be promoted, tagged, deployed, or rewritten
  until every release gate in `docs/BETA_READINESS.md` is proven.

Always fetch all branches and tags before relying on these statements.

## Non-negotiable invariants

- Preserve durable task, account, mutation, receipt, conflict, tombstone,
  timestamp, and cursor identities across every client and migration.
- Never clear an outbox entry or local conflict until the exact server
  acknowledgment has been validated.
- Realtime notifications are wake-up hints only. The cursor-based pull protocol
  remains authoritative.
- Preserve offline-first behavior and fail closed on malformed, unauthenticated,
  cross-user, stale, replayed, or incomplete data.
- Existing migrations are immutable. Add a new migration and update all
  migration/hash/Room ledgers when a schema change is needed.
- Every exposed Supabase table needs explicit grants and RLS. Client-visible
  credentials are publishable keys only; secret/service credentials remain on
  the server.
- Authorization uses the immutable Supabase user UUID, never email, Telegram
  username, phone number, or mutable user metadata.
- Do not touch the unrelated Supabase `Movetrics` project.
- Never print, commit, paste into issues, or store credentials, login codes,
  tokens, signing material, passwords, MFA seeds, or recovery links.
- Do not force-push, rewrite history, delete branches/tags, or remove preserved
  clients without explicit owner approval and recorded provenance.
- Do not weaken or skip a failing gate to obtain a green result.

## Working method

- Work from a short-lived branch based on the latest reviewed candidate.
- Implement the plan; do not stop after producing another plan.
- Keep changes small and reviewable. Prefer isolated commits for schema,
  authentication, realtime transport, native clients, tests, and evidence.
- Add regression tests for every fixed protocol or security defect.
- Run the narrowest relevant tests while iterating, then the full release checks
  before publication.
- Push each proven checkpoint and use GitHub Actions as the authority for macOS,
  Android emulator, PostgreSQL, and browser environments unavailable locally.
- Record exact commit SHAs, run URLs, job outcomes, artifacts, checksums, skips,
  and external blockers in the readiness ledger. Never convert a preflight skip
  into release evidence.
- Ask the owner only for actions that truly require a console choice, cost
  approval, retained credential, or external signer. Continue all independent
  repository work while waiting.

## Core verification

```bash
npm ci
npm run lint
npm test
npm run build
npm run verify:server
npm run verify:maintenance
npm run verify:migrations
npm run verify:migration-hashes
npm run verify:room-hashes
npm run verify:identifiers
npm run verify:release
```

When the environment supports them, also run the PostgreSQL migration suite,
Playwright Chromium/WebKit journeys, native Android checks and API-30 upgrade
journey, and the macOS test/build suite. Do not claim a platform passed based on
a substitute implementation.

## Definition of done

The work is complete only when the exact promoted commit has:

- typed email OTP and Telegram OIDC sign-in working on Web, native Android, and
  native macOS;
- secure Telegram Bot linking and Mini App authentication proven live;
- durable near-instant convergence across Web, Android, macOS, Bot, and Mini App
  with reconnect and polling fallbacks;
- hosted auth, RLS, cross-user isolation, sync, conflict, replay, revocation,
  backup, destructive staging restore, and post-restore convergence evidence;
- a signed Android internal-beta APK and a verified macOS beta artifact;
- fully green required CI, including the complete-history secret gate;
- separately configured staging and production infrastructure;
- an exact production deployment, smoke test, protected branches, and the
  `v0.4.0-beta.1` tag.

If any item is unproven, report `NOT READY` and name the exact remaining action.
