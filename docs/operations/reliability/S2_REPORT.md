# S2 implementation checkpoint

Stage acceptance: **BLOCKED — implementation continues. S3 is not permitted.**

S1's tested commit `09245261b6174ec878f0296ca61682c603f54304` is integrated.
S1.2 correction `262fa6e96a8cba7d0ebbb6843b9f8a0131b4cb7d` is integrated;
see `S1_2_REPORT.md`. Active branch: `codex/s2-causal-counters-20260907`.
No deployment, installed-app replacement or live data writes were performed.

## Validated transport checkpoint

`adc0b1c08cd64fa5d7e9613c81a47e4bb117ff85`: **PASS_LOCAL** for byte-bounded
push batches on Web, Android and macOS. This is not counter/focus acceptance.

S2-T01: reproduced HTTP 413 when seven individually valid multibyte notes were
batched together. All clients now select an ordered prefix within 262144 UTF-8
JSON body bytes and 50 entries. Wire fields and original timestamp precision are
unchanged. Selection happens before marking an attempt. The Web integration
fixture drains the queue and verifies each exact receipt/payload. Native tests
exercise the actual serializer and boundary helper used by each sync engine.

S2-T02: a single oversized captured change is preserved with a recoverable
diagnostic; no request or new attempt marker is generated. Full resumable
large-record recovery and pre-admission validation remain unimplemented. Do not
claim all valid queues can yet converge.

Validation:

- `npm run verify:release`: exit 0; 431/431 tests, type checking, Web/Mini/server
  builds, server/maintenance and artifact checks passed.
- `xcodebuild test -project macos-native/GoalflowMac.xcodeproj -scheme GoalflowMac
  -configuration Debug -destination 'platform=macOS' -derivedDataPath
  /private/tmp/s2-macos-tests CODE_SIGNING_ALLOWED=NO`: exit 0; 219 passed,
  one hosted transport test skipped. No hosted proof inferred.
- `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
  ./android-native/gradlew -p android-native testProductionDebugUnitTest
  lintProductionDebug assembleProductionDebug -PgoalflowSkipSigning=true`:
  exit 0; 137 passed, one hosted test skipped; lint and debug APK build passed.
  No installation or signing/release acceptance claimed.
- Migration manifest (22), Room manifest (8), durable identifiers (20) and
  static migration checks passed; these do not substitute for PostgreSQL tests.

Failed attempts are retained: baseline 413 regression; sandboxed Web suite
could not bind loopback; initial extracted Swift helper had an out-of-scope UUID
validator (corrected); Android's local release-keystore setting referenced an
absent file, so the documented unsigned local option was used. No stored
signing settings were changed.

## Database investigation

Read-only staging definitions and applied history are in
`s2-live-definitions.json`. The isolated PostgreSQL 17.11 database produced the
same push function MD5 as staging: `95ada6932c85d9b24a7022277421c355`.
S2-L01: two real concurrent transactions reproduced SQLSTATE `40P01` between
explicit conflict resolution and automatic reconciliation. Forward correction `8e7d6fd3ab03e9e97cdc5fa8ffc32da75d8bf55b` passes both empty and upgrade
PostgreSQL matrices, including original receipt checks and real two-transaction
lock/cursor regressions. The racing explicit resolution now fails safely with
22023 after reconciliation wins. Publication-order advisory locking is unchanged.
`PGHOST=/private/tmp PGPORT=55437 bash scripts/test-postgres-migrations.sh` exited
0. Migration/hash/identifier ledgers pass with the appended migration.
No database claim extends to a live rollout. The remaining action protocol needs
its own lock-order audit across completion and projection writers.

## Shared domain checkpoint

`d310047197413b3ec794cd3eddc7ac1b64e8b158`: **PASS_LOCAL** for shared domain fixtures in TypeScript,
Kotlin, Swift and real PostgreSQL. Twelve counter scenarios run in both orders;
nine focus sequences cover additive extensions, retries, explicit paused-control
semantics, terminal history and clock setbacks. These helpers do not yet admit
application writes or establish trusted migration baselines.

`npm run verify:release` exited 0 with 458 tests. Native Android unit/lint/debug
build exited 0 (140 passed, 1 hosted test skipped).
The macOS suite exited 0 (223 passed, one hosted test skipped). Both PostgreSQL
empty/upgrade matrices passed with 25 migrations, including the shared fixtures
and real lock/cursor tests. Migration, hash, Room and identifier gates passed.
Exact commands and artifact identities are in `S2_HANDOVER.json`.

The fixtures exposed Swift JSON canonicalization treating parsed numeric zero
as boolean false. NSNumber type discrimination now retains primitive types;
a regression covers zero, one, false, true and decimal one. Original attempted
payloads are unchanged. The failed fixture output is retained with final logs.

The two additive SQL migrations install private pure transition helpers;
client execution is denied. No live schema was changed. Coordinator integration,
trusted baseline admission and versioned server action receipts remain required.

## Browser cutover checkpoint

`35b37d006d4263a1b500b9dc48a7e58643e25468`: **PASS_LOCAL** for a dormant atomic IndexedDB
migration. It preserves all tracking keys and original sync preimages in private
authority, then recreates the existing tracking store with an inline key. Direct
old `put(value, accountKey)` fails even after reopening the latest DB. The actual
S1 flush rejects earlier on preservation validation and retains its exact WAL.
Legacy deletion of the compatibility projection leaves private authority intact.

Four new Chromium/WebKit journeys passed, along with 42 existing S1 journeys,
462 Web tests and 22 identifier checks. A failed preservation write aborts the
whole schema upgrade; concurrent/repeated upgrades retain original preimages.
An uncooperative older connection delays migration until it closes; its final
write is then preserved. The current connection handler incorrectly accessed
`event.target.result`; it now closes the actual database target.

The initial browser expectation of DataError on S1 flush failed: its existing
preservation check rejects first with DurableStorageError. Both observed checks
are now asserted separately; no production validator was weakened. Original
failure evidence is retained. Migration is not invoked by production application
flows yet. Durable WAL quarantine, new admission/readers, backup/import and
server capability activation remain required before use.

## Local causal admission checkpoint

`44f1a00a4196cd3836dd1c9d442dcf9ae42ee0da`: **PASS_LOCAL** for a dormant browser coordinator
that captures intent before awaiting storage, reads its actual parent and task
eligibility inside one transaction, and writes the projection, history and
outbox together. Repeated actions preserve identity; stale F commands never act
on G. A failed projection write rolls back every effect and the same action can
be retried. Exact observed legacy WAL strings are retained without inferring
a counter delta. Completion is explicitly unavailable here until its final-notes
logical transaction exists.

S2-I01, `e9d35eda2e95333cb04f67fd782ee2e79c74f1ad`: canonical JSON sorting on Web and server
used a normal object accumulator, dropping own `__proto__` fields. A regression
proved that the server could accept a receipt missing that field. A null-prototype
accumulator now preserves it as JSON data. No attempted request was rewritten;
a historical fingerprint produced by the defect may require explicit recovery.

Full Web release checks passed with 468 tests; all six causal-storage browser
journeys passed in Chromium/WebKit and 22 identifiers passed. Exact commands and
failure evidence are in the handover. Application controls, new-state readers,
server receipts, native coordinators and atomic completion remain unconnected.
This checkpoint does not prove cross-client causal convergence.

## Local counter admission checkpoint

`af60a79ca68ccc7a5a2fafa54320cc9e6a0bf427`: **PASS_LOCAL** for dormant counter admission under the
same protected IndexedDB transaction as focus. An explicit immutable baseline
and stable event identity produce 28/4 then 29/5 from 27/3; replay adds nothing.
Concurrent focus extension and counter increments preserve each other's fields.
Delayed previous-day events retain their day without changing today's projection.
Failed projection writes roll back the event and outbox; retries reuse identity.
Baseline mismatches and historical evidence replay fail closed.

Four new unit cases and all eight Chromium/WebKit causal-storage journeys passed.
Full Web release checks passed with 472 tests. Initial sandbox attempts could not
bind localhost; successful authorized retries and failure logs are retained.
This helper accepts an explicitly supplied baseline; trusted baseline acquisition,
UI activation, day selection, server acceptance and native integration remain.

## Remaining acceptance work

Implement/prove the private counter/action ledger, baseline/legacy ambiguities,
all-client transactional causal commands and atomic completion, forward schema
and receipts, bounded history reconciliation, old-tab write
fencing/import and mixed-version rollout, shared TS/Kotlin/Swift/PostgreSQL
fixtures, complete native gates and final independent compatibility review.
`S2_PROTOCOL_ADR.md` records the design; it is not evidence these paths exist.
Final S2 commit and S3 handover are intentionally unset until these pass.

## Conflict pagination checkpoint

`b9d8503456d8ca4954f7567dc31c48a471d16335`: **PASS_LOCAL**. Web, Android and Mac now scan the additive
`GET /api/v1/sync/conflicts/page` endpoint using immutable UUID order, at most
20 conflicts per response. An explicit empty page terminates the scan, so a
lower PostgREST row cap cannot silently truncate it. Each validated page merges
durably before the next request. The cursor restarts on every sync; it is not
a committed-change high-water mark. Concurrent insertions behind the scan
appear on the next sync; resolving visited rows cannot skip later rows.

Tests recovered 1,003 synthetic conflicts with a seven-row database cap and
intervening resolution. Android additionally proves an invalid continuation
retains the already imported first page. Web rejects backward, duplicated,
skipping, omitted and malformed cursors. Full Web release: 482 passed. Native
Android: 141 passed, one hosted skip; lint and debug build passed. macOS: 223
passed, one hosted skip. These are local tests, not hosted/PostgREST acceptance.
The server query test exercises the installed Supabase client against synthetic
HTTP responses. Initial native sandbox, keystore and Java toolchain failures
are retained alongside successful gate logs.

Deploy the server endpoint before upgrading clients. The legacy endpoint is
unchanged for old clients. New clients fail closed against an older server;
they do not fall back to an unpaged response. No migration, deployment or owner
app installation occurred. Pagination bounds row count, not arbitrary legacy
record size; existing response byte limits still apply. Oversize historical
records and staged reconciliation history remain separate unfinished work.

## Private server action ledger checkpoint

`31e4c184e801cbf542c96a52e9fa8e2cb8e80bfc`: **PASS_LOCAL** for the additive private ledger. Migration
`20260907220709_s2_private_action_ledger.sql` creates no enrolled account.
An explicitly invoked cutover compares the exact canonical tracking payload
and server version, establishes its existing counts as baseline, and retains
an immutable cutover receipt. Distinct focus/counter operations receive exact
schema-v2 receipts with a separate projection revision. Account/action IDs
deduplicate globally across command kinds; legacy mutation IDs cannot become
new increments. Counter events are stored separately and unknown fields survive.

The tracking entity lock serializes causal admission and legacy writes. After
cutover, legacy protected-field changes receive their original rejected v3
receipts. Other writers cannot alter protected fields through the tracking
trigger. Equal-time focus commands use causal authority rather than the legacy
LWW trigger. Publication retains `goalflow_next_change_version` and its global
transaction lock. Private tables have RLS and no client schema/table access;
RPC execution is limited to the trusted server role.

Both complete PostgreSQL empty/upgrade matrices passed, including old protocol
and backup tests on non-enrolled accounts, 12 shared counter scenarios in two
orders, nine focus scenarios, existing concurrency checks, and new real SQL
service-role tests for 27/3→29/5, +420, exact duplicate receipts, rollback,
concurrent deduplication and ordered publication. Migration/hash gates checked
26 migrations; identifier gate passed. Initial failures were fixture SQL_ASCII
encoding and a synthetic task missing its required schedule. The matrix now
creates UTF-8 databases explicitly. Failed and successful evidence is retained.

This is not activation evidence. There is no HTTP cutover caller yet. Completion
and corrections explicitly reject until atomic effects/evidence are implemented.
Only the initial day's baseline is established. Backup/restore of enrolled
accounts, legacy ambiguity/import, day selection, client receipt processing
and capability activation remain required before rollout. No live DDL occurred.

## Android active completion checkpoint

`b899bd5ac5f7975fca45a86e16e2c7028edac4be`: **PASS_LOCAL**. The active Android ViewModel captures its
focus target before launching asynchronous work. The repository validates that
session/task inside one Room transaction and commits final notes, existing task
statistics/goal/habit/event effects, outbox changes and focus termination together.
Mutation notification occurs after commit. Unknown fields on the same focus
session survive the write. Duplicate completion does not award again; a terminal
session cannot complete the task again after task undo, or target a replacement
session. Contradictory final notes on a completed action report a recoverable error.

A real Room failure trigger on the final tracking write proved complete rollback
and successful retry with final notes intact. Two new regression tests cover
rollback/retry/deduplication/undo and stale same-task session replacement. All
143 native Android tests passed; one hosted test skipped. Native lint and debug
build passed. No schema change or app installation. This fixes local atomicity;
the current legacy multi-entity transport is not a server-atomic completion receipt.
