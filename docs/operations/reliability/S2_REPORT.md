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

## Remaining acceptance work

Implement/prove the private counter/action ledger, baseline/legacy ambiguities,
all-client transactional causal commands and atomic completion, forward schema
and receipts, bounded history reconciliation and paged conflicts, old-tab write
fencing/import and mixed-version rollout, shared TS/Kotlin/Swift/PostgreSQL
fixtures, complete native gates and final independent compatibility review.
`S2_PROTOCOL_ADR.md` records the design; it is not evidence these paths exist.
Final S2 commit and S3 handover are intentionally unset until these pass.
