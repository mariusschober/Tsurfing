# Shared focus-session server safeguards — 7 September 2026

The existing tracking singleton carries an optional focusSession object alongside
daily counters. The server merges that field independently so older clients
cannot erase a running or ended session when updating counters. No new table,
entity type, public grant, or change to original mutation fingerprints is needed.

- Valid action timestamps decide focus conflicts; the current cloud value wins ties.
- Missing or null focus fields preserve the current session. Stop/completion is explicit.
- A terminal session cannot become active again under the same session identity.
- A new session identity permits the next deliberate start.
- Strict numeric, phase, identity and timezone checks reject malformed records.
- Focus clocks more than five minutes ahead of the server are rejected.
- Automatic reconciliation combines the newest focus action from the full local
  history with the ordinary daily-record winner. Original rejected receipts and
  complete reconciliation candidates remain unchanged in the audit ledger.
- Retried automatic reconciliation returns current canonical state and cannot
  reapply an old pause or completion over a later session.

Validation: full PostgreSQL migration suites passed on fresh and upgrade
fixtures, including existing restore, RLS, idempotency and sync checks. New
regressions cover legacy omissions, stale daily copies, nulls, session identity,
terminal resurrection, timestamp ties, stale-CAS field merges, rejected-receipt
immutability, history tails without focus, missing-cloud recovery and replay.
Migration hash checks and static integrity verification passed.

This is local database evidence. Hosted application, Mac and Android convergence
must be verified after integrating and deploying the client implementations.

The receipt guard routes a push through the normal rejected-conflict path when
focus preservation would change its payload. Only the separate audited
reconciliation operation writes the combined canonical record. Every accepted
v2 receipt still proves the exact original payload; API and client validation
remain unchanged. This is necessary for older installed clients to keep syncing.

Both safeguards were applied to Tsurfing Staging (xyjgpwwvsyjhurkycyqr): hosted
migration versions 20260907124437 (focus_session_preservation) and
20260907124452 (focus_session_receipt_guard). A read-only hosted query confirmed
legacy omission preserves the focus value, the exact-receipt guard is active,
the trigger is enabled, and authenticated users cannot execute the internal
helper. Security advisors were unchanged from the pre-migration baseline.
No owner records were modified by these verification queries. Client convergence
remains pending until the new apps are installed and tested.
