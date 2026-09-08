# Tsurfing beta deployment runbook

Status: pre-beta. No hosted Tsurfing environment is release evidence until its
exact commit, configuration, migration state, and live verification are recorded
in `docs/BETA_READINESS.md`.

## Environment topology

Use one private Railway project with two persistent, isolated environments:

| Environment | Git source | Deploy policy | Supabase project |
| --- | --- | --- | --- |
| staging | `develop` | automatic after `beta-gate` | Tsurfing Staging only |
| production | `main` | explicit release promotion only | Tsurfing Production only |

Each Railway environment contains `tsurfing-web-api` and the one-shot
`tsurfing-maintenance` cron. `.railway/railway.ts` is the source-controlled
infrastructure definition; the retired `railway.json` mechanism must not be
used. Follow `.railway/README.md` to plan and apply it.

The private Railway project exists with its default, empty `production`
environment. An empty persistent `staging` environment must still be created;
do not duplicate production or copy its variables.

## Supabase

Use the existing empty `Tsurfing` project as `Tsurfing Staging`. Production must
be a completely separate `Tsurfing Production` project in `eu-west-1`. On the
Supabase Free plan, prove staging, pause and confirm it is paused, and only then
create production at a displayed cost of `$0`; stop if the console requests
payment or current limits differ. Never inspect or modify Movetrics. Apply every
file in `supabase/migrations` in
filename order from an empty database. Existing migration files are immutable;
fixes are new forward-only migrations and must be added to
`MIGRATION_SHA256_MANIFEST.json`.

Use current key conventions:

- `SUPABASE_PUBLISHABLE_KEY` may be referenced by browser/native builds.
- `SUPABASE_SECRET_KEY` is Railway-server-only and must never use a `VITE_`
  name or enter an Android/macOS bundle.
- Legacy anon/service-role variable names remain compatibility aliases only.

Before deployment, verify extensions, grants, functions, triggers, RLS and
storage policies, then run two-user hosted isolation tests. A server operation
using the secret key must still authorize the immutable authenticated user UUID
explicitly because that key bypasses RLS.

Configure staging for `https://staging.tsurfing.com` and production for
`https://app.tsurfing.com`; each uses same-origin `/api` and `/mini`. Configure
each project’s Site URL and redirect allowlist to exact HTTPS origins.
Staging and production URLs must never appear in the other project’s allowlist.
Configure reliable custom SMTP before testing registration, email verification,
or password recovery. Public registration may be enabled only with the
application approval/invite gate active.

## Railway variables

Define these as environment-level shared variables independently in staging and
production:

- `APP_ORIGIN`
- `OWNER_USER_ID`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `BACKUP_MASTER_KEY`

`BACKUP_MASTER_KEY` must decode to exactly 32 random bytes and must be retained
outside both Railway and Supabase. Losing it makes application backups
unrecoverable. Never copy a staging key into production or vice versa.

Optional server features remain explicitly disabled until separately proven:

- `TELEGRAM_ENABLED=false`
- `AI_ENABLED=false`
- `VOICE_ENABLED=false`
- `TURNSTILE_ENABLED=false`

The web service uses `BACKUPS_ENABLED=false`; the maintenance service uses
`BACKUPS_ENABLED=true`. Railway schedules `npm run maintenance` once daily. The
command exits nonzero if configuration, backup, upload, metadata finalization,
or retention fails.

## Boot and promotion checks

- `/api/v1/health/live` proves only that the process is alive.
- `/api/v1/health/ready` returns 200 only after the production configuration and
  minimal Supabase dependency probes succeed.
- Configure Railway’s deployment health check to the readiness endpoint.
- Never promote a deployment based on liveness alone.
- In each staging service, enable GitHub autodeploy and **Wait for CI**. In each
  production service, explicitly disable GitHub autodeploy in Railway service
  settings; this dashboard toggle is not inferred from the source branch.
- Promote only after the exact commit has a successful `Beta Gate` push run on
  `main`. Use Railway’s manual **Deploy Latest Commit** action for both the web
  and maintenance services, then record their deployment IDs.

## Release verification

From a clean Node 22 checkout:

```bash
npm ci
npm run verify:release
npm run test:migrations:postgres
```

The full GitHub `beta-gate` additionally owns Chromium/WebKit, legacy Android,
native Android, migration execution, complete-history secret scanning, and—once
credentials exist—hosted staging auth/RLS/sync checks. A local pass is never a
substitute for those hosted checks.

Signed Android artifacts are created only by the protected manual release
workflow. It requires all signing secrets and an expected certificate SHA-256
fingerprint. Ordinary CI artifacts are explicitly test-only and unsigned/debug.

## Restore safety

Run destructive restore tests only in staging with synthetic accounts. Require a
pre-restore snapshot, dry run, explicit confirmation, checksum/authentication
verification, and post-restore row/ID/sync checks. A partial database or storage
step must remain marked failed and must never be reported as a successful
restore.
