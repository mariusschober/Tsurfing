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

## Remaining acceptance work

Implement/prove the private counter/action ledger, baseline/legacy ambiguities,
all-client transactional causal commands and atomic completion, forward schema
and receipts, bounded history reconciliation and paged conflicts, old-tab write
fencing/import and mixed-version rollout, shared TS/Kotlin/Swift/PostgreSQL
fixtures, complete native gates and final independent compatibility review.
`S2_PROTOCOL_ADR.md` records the design; it is not evidence these paths exist.
Final S2 commit and S3 handover are intentionally unset until these pass.
