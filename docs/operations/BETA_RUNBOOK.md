# Tsurfing beta operations

This runbook covers the small staging/production deployment and encrypted
application-level backups. Commands are implemented, but no live Tsurfing
Supabase or Railway environment has been proven yet. Do not label a deployment
ready until the staging drills below have produced retained evidence.

## Environment boundary

Use one Railway project with independent persistent `staging` and `production`
environments. Each environment has one web/API service and one one-shot
maintenance service from the same Git commit. Staging follows `develop`.
Production follows `main` only through manual promotion. Never copy a Supabase
database, server key, backup key, test identity, or storage object between the
two environments.

Configure the server-only values documented in `docs/ACCOUNTS_AND_KEYS.md`.
`BACKUP_MASTER_KEY` must decode to exactly 32 random bytes and must be retained
outside Railway as recovery material. It must never use a `VITE_*` name or enter
a web/native build. Set `BACKUPS_ENABLED=true` only on the one-shot maintenance
service after the first staging restore succeeds.

## Deploy and health

1. Apply every `supabase/migrations/*.sql` file in lexical order to an empty
   staging project and retain the migration hashes.
2. Deploy the exact candidate commit using `.railway/railway.ts` or equivalent
   explicit Railway dashboard configuration. Enable GitHub autodeploy and
   **Wait for CI** on both staging services. Keep both production service
   triggers disabled and use **Deploy Latest Commit** only after a successful
   Beta Gate push run for the exact commit on `main`.
3. Require `GET /api/v1/health/live` to return 200 and
   `GET /api/v1/health/ready` to return 200. Liveness alone is not deployable.
4. Run `npm run test:hosted:staging` and then `npm run
   test:hosted:browser` with two nonproduction identities. The first command
   proves API ownership, account export, safe deletion refusal, idempotency,
   conflict/tombstone behavior, refresh, revocation, and two authenticated
   sessions. The second proves create/edit/delete convergence between two real
   browser profiles for user A while a user-B browser remains isolated.
5. Run the `hosted-cross-client` Beta Gate job for the exact candidate. It must
   seed one durable task through the hosted UI, pull/edit/push it through the
   production Android sync engine, verify that edit in a fresh browser,
   pull/edit/push it through the production macOS transport, verify again, and
   delete/recheck the fixture with both test accounts. Retain the Actions run
   and job IDs. A compile-only native test or synthetic API is not a substitute.
6. Promote the same source and independently configured production variables
   only after every staging gate passes.

## Scheduled backup

Run `npm run maintenance` as a Railway cron invocation once per UTC day. The
process performs one complete pass and exits nonzero if protocol validation,
database export, encryption, metadata insertion, object upload, finalization,
or retention fails. It never runs a long-lived in-process timer.

New objects use the `GFB2` AES-256-GCM envelope. A random salt and HKDF-SHA256
derive a different key for each user from the master key; the user identity and
envelope header are authenticated as associated data. Existing `GFB1` objects
remain readable with the same retained master key. Metadata is `failed` before
upload and becomes `complete` only after the encrypted object is durable.
Retention keeps seven complete daily and four complete weekly backups per user.
Completed pre-restore snapshots use a separate metadata kind and are never
removed by automatic daily/weekly retention.

For each staging run, retain the maintenance invocation ID and verify:

- exactly one new `backup_metadata` row reaches `complete`;
- its object exists in the private `goalflow-backups` bucket;
- `byte_size`, checksum, and `encryption_version` match the object;
- the maintenance command read the uploaded ciphertext back byte-for-byte and
  authenticated/decrypted it before marking metadata `complete`;
- an upload/finalization fault leaves no object reported as complete;
- retention deletes one object at a time; an uncertain storage deletion leaves
  that metadata row `failed` and exits nonzero, never falsely `complete`.

## Dry-run restore

Use only a completed metadata row and its exact object path:

```bash
npm run restore:backup -- \
  --user "$GOALFLOW_STAGING_USER_ID" \
  --object "$GOALFLOW_STAGING_BACKUP_OBJECT" \
  --expect-revision "$GOALFLOW_EXPECTED_RELEASE_SHA" \
  --dry-run
```

`GOALFLOW_EXPECTED_RELEASE_SHA` is the exact 40-character candidate commit.
Success is a single JSON record with `mode: "dry-run"`, `valid: true`, and the
same `releaseSha`.
The command checks metadata/object byte size and envelope version, authenticates
and decrypts the object, verifies its checksum and owner, and calls the
non-mutating database validator. A dry run never creates a pre-restore backup
and never invokes the destructive RPC.

## Staging restore drill

Never use production user data for this drill. Record the target user's row
counts and durable IDs, create a known post-backup mutation, and then run:

```bash
npm run restore:backup -- \
  --user "$GOALFLOW_STAGING_USER_ID" \
  --object "$GOALFLOW_STAGING_BACKUP_OBJECT" \
  --execute \
  --confirm-user "$GOALFLOW_STAGING_USER_ID" \
  --expect-revision "$GOALFLOW_EXPECTED_RELEASE_SHA"
```

The command refuses to execute unless Railway exposes that exact deployed
revision. It then creates and finalizes an encrypted `pre-restore` object. The
database replacement and AI-usage recovery then run in one PostgreSQL
transaction. The post-commit verifier compares row content as well as durable
IDs and counts, allowing only documented sequence/rebase fields. AI quota
usage, sync mutation receipts, API receipts, conflicts,
and restore tombstones are non-rewindable safety ledgers: backup identities
must remain present, while newer rows may also remain. Content tables require
exact row counts and durable IDs. The command re-exports committed state and
does not report success until those checks pass.

If the RPC fails, PostgreSQL rolls back the entire database change. If the RPC
commits but post-restore verification or the network fails, the command exits
nonzero and prints the completed pre-restore object path as the recovery point;
it does not claim success. Dry-run that recovery object before any explicit
rollback. After a successful staging restore, prove the user can log in, sync
from a fresh client, receive tombstones, and converge with an offline client.

## Incident rules

- Treat any `failed` backup metadata row or maintenance nonzero exit as an
  incident; never relabel it manually as complete.
- Do not delete an orphaned object until its metadata and checksum have been
  reconciled.
- Do not rotate or discard the backup master key while retained objects still
  depend on it. A future key rotation needs explicit key-version metadata and a
  tested re-encryption procedure.
- Never run an execute restore against production as a test. In an actual
  recovery, require a successful dry run, explicit target UUID confirmation,
  and retained pre-restore object.
