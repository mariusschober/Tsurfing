# Tsurfing beta account and key inventory

This is an inventory of external prerequisites, not a place to record secret
values. At the 2026-09-04 handover, `chore/railway-beta-gate` was the complete
candidate and `integration/beta` was 86 commits behind it. Advance
`integration/beta` only after the protected staging/signing configuration can
run honestly; `main` remains obsolete until release proof is complete. Always
fetch before relying on this checkpoint.

## Current external state

- GitHub access and Actions are working. The required aggregate check is
  `beta-gate`.
- A private, empty Railway project currently named `Goalflow` exists with only
  its default production environment. It is dedicated to Tsurfing and may be
  renamed/reconfigured; the isolated staging environment and both services are
  not yet configured or deployed.
- The connected Supabase organization contains an empty `Tsurfing` project in
  `eu-west-1`; it is the staging target and may be renamed `Tsurfing Staging`.
  The unrelated `Movetrics` project must never be inspected or modified.
- No `Tsurfing Production` Supabase project has been created or proven. On the
  Free plan it is created only after staging is proven and confirmed paused.
- Telegram, AI, voice, Turnstile, custom SMTP, and Android release signing have
  not passed their live beta gates.

## Supabase staging and production

For each independent project, retain outside the repository:

- project reference and database administration access;
- `SUPABASE_URL`;
- browser-safe `SUPABASE_PUBLISHABLE_KEY`;
- server-only `SUPABASE_SECRET_KEY`;
- exact authentication Site URL and redirect allowlist;
- custom SMTP configuration;
- two synthetic staging identities used by the isolation matrix.

The fail-closed hosted CI job reads these GitHub Actions secrets. Values must
belong only to Tsurfing staging; never reuse production credentials:

- `GOALFLOW_STAGING_APP_ORIGIN`;
- `GOALFLOW_STAGING_SUPABASE_URL`;
- `GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY`;
- `GOALFLOW_STAGING_USER_A_EMAIL`, `GOALFLOW_STAGING_USER_A_PASSWORD`, and
  `GOALFLOW_STAGING_USER_A_ID`;
- `GOALFLOW_STAGING_USER_B_EMAIL`, `GOALFLOW_STAGING_USER_B_PASSWORD`, and
  `GOALFLOW_STAGING_USER_B_ID`.

Both identities must have active `beta` profiles. `npm run
test:hosted:staging`, `npm run test:hosted:browser`, and the CI-only
`hosted-cross-client` job additionally require the explicit non-secret guard
`GOALFLOW_HOSTED_TEST_CONFIRM=staging`. The protocol harness creates uniquely
identified test tasks and finishes them as tombstones. The browser harness
signs in through the real UI with two independent user-A browser profiles and
one user-B profile, then creates, edits, synchronizes, and deletes a uniquely
named task.

The cross-client job hands one durable browser-created task through the actual
production Android sync engine and production macOS URL-session transport,
verifying each edit through a fresh browser before deleting and rechecking the
fixture with both accounts. Its private handoff file contains only the durable
task UUID and unique test titles, lives in the CI runner temporary directory,
and is removed after verified cleanup. Test-only password sign-in obtains
short-lived user-A sessions; no server credential enters either client. None of
these harnesses may target production.

The hosted browser configurations deliberately retain no trace, video,
screenshot, or HTML action report because those artifacts could capture the
real test password. CI retains only explicitly redacted console, page-error,
and network-status diagnostics.

Only the publishable key may enter `VITE_SUPABASE_PUBLISHABLE_KEY` or a native
application configuration. The secret key must exist only in the corresponding
Railway environment. Do not use secret-key behavior as RLS evidence because the
secret key bypasses RLS.

The owner is authorized by immutable Supabase user UUID (`OWNER_USER_ID`), not
email address. Never record test passwords, access codes, recovery links, tokens,
MFA seeds, or key values in this file.

## Railway

Configure the shared variables listed in `DEPLOYMENT.md` independently for
staging and production. Use `.railway/railway.ts`; do not recreate the retired
`railway.json` setup. Staging follows `develop`; production follows `main` but
keeps automatic deploys disabled.

The backup master key is a separately retained 32-byte random secret. It is
server/maintenance-only, never client-exposed, and must be recoverable during a
restore drill.

## Optional features

Keep every optional feature flag false until its own live verification passes.
When enabled, retain these values only in the matching Railway environment:

- Telegram bot token, webhook secret, bot username and OIDC provider details;
- Turnstile secret (site key alone may be client-exposed);
- AI provider key;
- voice/transcription provider key.

Telegram requires a real test bot and complete webhook/replay/account-linking
matrix. AI and voice are not required for core beta task capture and sync.

## Android beta and release signing

Both protected GitHub build paths require:

- `ANDROID_KEYSTORE_BASE64`;
- `ANDROID_KEYSTORE_PASSWORD`;
- `ANDROID_KEY_ALIAS`;
- `ANDROID_KEY_PASSWORD`;
- `EXPECTED_CERT_FINGERPRINT`.

The keystore must be generated and retained outside the repository. The
`android-internal-beta` Beta Gate job additionally embeds only the three staging
public values already listed above. It runs only on an `integration/beta` push,
after every preliminary required job succeeds; it verifies one expected signer
and uploads an APK plus verified checksum and provenance without creating a
GitHub release. The job is scoped to the protected `internal-beta` GitHub
environment. The production release workflow remains restricted to an exact
successful `main` push and its separate `production-release` environment.

Do not reuse the historical temporary test signer mentioned in old evidence
snapshots. No keystore or private-key file is tracked anywhere in Git history,
but a password-like test value was removed from the current documentation as a
precaution. The beta signer must have a separately retained private key and an
independently recorded SHA-256 certificate fingerprint.

## Historical credential action

Complete-history scanning still finds one historical Firebase/GCP API-key-shaped
credential associated with an old Firebase project. Its value must never be
printed or copied. Before release, the owner must verify it in Google Cloud,
review usage, and revoke/delete it if unused or rotate/restrict it to the exact
required APIs and application/referrer boundaries. Record only the action and
date in `docs/security/HISTORICAL_CREDENTIAL_ACTIONS.md`.
