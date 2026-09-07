# Legacy Mac upload recovery — 2026-09-07

The owner completed email OTP and MFA. The Mac remained authenticated, but its
sync error banner offered Sign in for every error, including authenticated
HTTP 500 responses. Live UI confirmed the verified-session shield.

The first retained Mac task mutations were from the older NSNumber encoding
bug: plannedOrder and frogFailures held JSON booleans rather than integer 0/1.
The current native encoder already prevents this, but the original outbox
entries correctly retained their immutable payloads. PostgreSQL task projection
failed while casting these booleans to integers.

Forward migration 202609070001_legacy_mac_numeric_projection.sql accepts
boolean 0/1 only for known numeric fields on native-shaped task payloads
(durationMinutes present). It changes only canonical projection expressions.
It preserves request fingerprints, original sync payloads, mutation IDs,
receipts, user ownership checks, and all other invalid-input checks.

Evidence:
- Pre-fix PostgreSQL regression failed with invalid integer input true.
- Clean database and upgrade suites passed, including exact-payload replay,
  numeric projection, and rejection of string true/non-native booleans.
- Migration hashes and durable-identifier ledger were extended, without
  changing any existing migration or identifier.
- Applied to staging project xyjgpwwvsyjhurkycyqr via the migration API as
  legacy_mac_numeric_projection, hosted version 20260907101216.
- All six original owner Mac mutations have accepted durable receipts.
- The existing running Mac drained its outbox to zero without signing in
  again, clearing storage, or manually rewriting a pending mutation.

The Mac UI fixes remain on the separate Mac staging branch. The subsequent
pull revealed a second native decoder mismatch: web daily-plan confirmedAt
uses Unix milliseconds while the old Mac decoder accepted ISO text only.
That is handled in the Mac build, preserving the received wire data.
