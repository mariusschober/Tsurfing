# Railway configuration

`railway.ts` is the source-controlled Railway infrastructure definition. The
retired `railway.json` configuration is intentionally absent.

Use Railway CLI 5.42.1 or newer. Link the `Tsurfing` project, select the
persistent staging environment, inspect the plan, and apply it:

```sh
railway environment staging
railway config plan
railway config apply
```

Do not apply the production plan while `main` is still the obsolete source.
After the proven beta commit has reached `main`, select `production`, inspect
the plan, and apply it there separately.

Before the first deployment, define these shared variables independently in
each environment:

- `APP_ORIGIN`
- `OWNER_USER_ID`
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `BACKUP_MASTER_KEY`

The staging values must point only to staging Supabase and the production
values only to production Supabase. Never give a secret/server key a `VITE_`
name.

The definition maps staging to `develop` and production to `main`. GitHub
autodeploy enablement is an explicit Railway service setting, not an assumption
made by this file. For both staging services, enable autodeploy and verify
**Wait for CI** is enabled. For both production services, click **Disable** in
the GitHub deployment trigger settings. After the exact `main` push has a green
`beta-gate`, use Railway's **Deploy Latest Commit** manual action for each
production service and record both deployment IDs. A green check associated
with the same commit on another branch is not promotion evidence.

The web service is promoted only when `/api/v1/health/ready` returns 200. The
repository-backed maintenance cron service invokes the one-shot backup command
at 02:00 UTC and must exit nonzero when any user backup or retention operation
fails.
