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

## Complete staged reconciliation checkpoint

`2fa1423b06cadf904557de9d429c097e89013010`: **PASS_LOCAL** for Web/Android/macOS staged reconciliation.
Candidates above 1,000 history entries or 262,144 UTF-8 bytes are captured whole
and uploaded as immutable 64 KiB byte chunks. The manifest binds every chunk
hash, complete hash, byte length and chunk count. Staging keys include the full
manifest identity; a poisoned manifest cannot block a correct upload of the
same candidate. Every chunk acknowledgment is verified. Retries reuse captured
bytes; interrupted upload retains the entire local conflict. No history slice
is selected. After complete verification, the existing reconciliation RPC and
its exact whole-candidate receipt remain authoritative.

Supported candidate envelope: 4 MiB, 100,000 entries, at most 64 chunks. Each
chunk request fits 256 KiB even if an encoder escapes every base64 slash. The
existing 16 MiB response limit remains. Larger historical candidates remain
intact with an explicit recovery error. This does not yet remediate a single
oversized legacy push mutation. The legacy reconciliation endpoint retains its
1,000-entry limit. Deploy migration/server before client upgrade; failed staging
on an old server retains local evidence. Nothing was deployed.

Shared fixture hashes passed in TypeScript, Kotlin, Swift and PostgreSQL. Real
PostgreSQL tested incomplete uploads, exact replay, inconsistent-manifest
isolation, cross-account denial and reconciliation of all 1,001 history entries.
Both full migration matrices passed; 27 migrations and identifier checks passed.
Web integration resumed an interrupted upload with all entries intact. Web
lint, 488 tests and build passed. The combined release command subsequently
failed its liveness check because a separate Python process occupied port 4173;
`VERIFY_PORT=43973 npm run verify:server` passed, and remaining maintenance and
artifact gates passed separately. Initial refactoring changed duplicate-history
HTTP 400 to 500; the existing regression caught it and the 400 behavior was restored.

Android: 145 passed, one hosted skip, lint/debug build passed. macOS: 224 passed,
one hosted skip. An initial AppKit test received unrelated extra keyboard text;
`4a40232` removes explicit foreground activation without weakening responder
assertions. Its targeted test and full suite passed afterward. The first SQL
staging attempt lacked extension-digest permission; built-in PostgreSQL SHA-256
now verifies hashes without widening extension privileges. Failed logs remain.

## Oversized captured mutation checkpoint

`17d29ab3706231ea376a0d5aac696eec18d886ed`: **PASS_LOCAL** for staged legacy
push transport. Web, Android and macOS select an oversized first mutation alone,
mark its original identity attempted before upload, and reuse the verified chunk
carrier. `/sync/push-staged` accepts exactly one assembled mutation and invokes
the existing hardened push RPC and exact receipt validator. Payload, device,
entity, version and timestamps remain unchanged; staging is not acceptance.
Only the ordinary verified receipt retires the outbox mutation.

Supported single-mutation wire body: 4 MiB, at most 64 chunks of 64 KiB. Larger
captured changes remain intact with an explicit error and no network attempt.
This supersedes the preceding checkpoint's single-mutation transport limitation.
New-edit admission above the supported size still needs implementation. No new
migration, deployment or native installation occurred. Deploy the staging
migration and updated server before upgrading clients.

Browser and Android Room tests interrupt an upload at chunk 1, retain the
original request, replay identical chunk 0 and then retire only the original
acknowledged mutation. HTTP tests reject altered accepted payloads and reject
assembled multi-mutation bodies. Swift native tests reconstruct the exact
oversized body from its chunks. This is not hosted end-to-end evidence.

`VERIFY_PORT=43973 npm run verify:release`: exit 0, 490 tests passed. An additional
exact 4 MiB boundary test passed afterward (4 envelope tests). Android final:
146 passed, one hosted skip; lint and debug build passed. macOS: 224 passed,
one hosted skip. The first HTTP attempt was sandbox-blocked from binding a
loopback socket; the permitted rerun passed. Initial recovery-test assertions
incorrectly compared attempt metadata and assumed Android's notes field name;
corrected assertions verify immutable wire fields and the complete native payload.
Failed and successful logs are retained in `evidence/s2-staged-push-*.log`.

## New-record admission checkpoint

`31e216cb4d92a918e79ad8f3598f724ed5a16230`: **PASS_LOCAL**. New changed records
are limited to 3 MiB of platform-serialized UTF-8 JSON payload, reserving room
for metadata within the 4 MiB staged transport. Web validates before capturing
the action or group WAL; Android validates inside the same Room transaction as
task/event/outbox writes; macOS validates before its atomic local commit.
Errors do not report durable success or truncate the draft. Previously captured
outbox requests retain the 4 MiB recovery path. Web WAL replay does not reapply
this admission gate. An oversized fresh Android import fails atomically and
retains its source and the current database. Larger historical queues and
reconciliation histories remain intact with their documented recovery errors.

Full Web release checks: exit 0, 493 passed. Android: 147 passed, one hosted skip,
lint and debug build passed. macOS: 224 passed, one hosted skip. Browser grouped
admission and native failure tests preserve the prior task and outbox; Android
also proves a failed new task leaves no task row or mutation. The initial Web
type check caught an invalid test-only property access; comparing the complete
draft fixed it. Both logs remain. No schema change, deployment or installation.

## Android active focus transaction checkpoint

`65ea3a26e531597d5e03b6985ee5d2230b02eed6`: **PASS_LOCAL**. The ViewModel captures target task/session and action time before launching asynchronous work. Start reads actual task eligibility and duration inside Room. Pause/resume/extend/stop transform the persisted parent inside the same transaction as the tracking and outbox write. Concurrent +300/+120 extensions compose to +420. A stale F pause cannot affect replacement G on the same task. An interrupted write retains parent and outbox, and retry succeeds. Legacy offline import now checks for an absent focus field inside Room; explicit null, terminal and malformed fields cannot be replaced by an old mirror.

Full Android unit/lint/debug build: exit 0; 149 passed, one hosted skip. No schema change or installation. This fixes the active local transaction race; versioned causal action receipts, logical operation deduplication and cross-client terminal history still require integration. It is not full S2 acceptance.

## macOS active focus transaction checkpoint

`eb8237f0c9ba0ff2d22f9fd07cedb343875928c5`: **PASS_LOCAL**. Shared focus controls capture explicit target/time intents before awaiting the sync gate. The actual tracking and task state is read and transformed under the existing recursive storage lock. Start uses current task eligibility/duration; stale F commands cannot affect replacement G. Concurrent extensions compose; invalid ranges fail before arithmetic/persistence; unknown tracking/focus fields survive. Legacy import cannot replace an existing focus field. The default view model now uses its task store directory and defaults for the sync bridge.

Completion reads final notes and elapsed time from current durable state, excludes paused time, and journals task/status and terminal tracking with both outbox effects as one recoverable local commit. An injected failure after the first file write recovers both sides before a normal reader exposes data. Duplicate completion adds nothing. This retains existing macOS task-completion effects; it does not establish a server-atomic or cross-client causal action receipt.

Full macOS suite: exit 0, 225 passed, one hosted skip. The first test attempt correctly rejected a synthetic focus import with no task; the fixture now includes a real synthetic task. Subsequent full runs passed, including the final persisted-parent duration test. No migration, installation or deployment.

## Server counter-day checkpoint

`3f4a14a8cf620c29a0370acc8ce27183f2117664`: **PASS_LOCAL**. The additive `goalflow_counter_day_v2` RPC establishes an empty post-cutover day only when available legacy evidence permits it. Historical days, existing day claims and unattributed accepted legacy receipts require baseline review. Existing baselines are immutable and shared across actors. Selecting a day projects its distinct accepted events while preserving focus and unknown fields. Delayed events retain their original day. Zone changes do not reset counts. Baseline identities cannot be reused as actions on another day. No account is enrolled or client activated by this migration.

Both real PostgreSQL migration matrices passed, including exact receipt replay, concurrent baseline establishment, cross-account rejection and failure rollback without cursor advancement. Migration/hash checks: 28; identifiers: 22. Advisors exited 0 with the existing test-bootstrap pgcrypto-in-public warning. The first advisor connection required disabling SSL for the loopback-only fixture; both fixture databases were removed afterward. Initial cutover test failure came from a synthetic legacy request lacking a newer revision/time; corrected evidence now passes. No live DDL.

## Causal API receipt checkpoint

`d9a7c6e942b10d3610455a00cb00295e0978b8f7`: **PASS_LOCAL**. `POST /sync/actions` submits one exact focus/counter/day operation using the authenticated user UUID. The API validates account scope, canonical command timestamps and exact version-2 receipts, including epoch, projection revision, tracking ownership, outcome and applicable counters. Unknown command fields remain intact, including own `__proto__` evidence. Rejected focus receipts remain auditable. Database review failures return sanitized 409 responses; serialization/deadlock failures request retry of the exact saved action. Legacy receipts remain separate. This endpoint does not enroll accounts or advertise rollout readiness. Completion and evidence-linked correction transport remain pending.

Final release checks: exit 0, 508 tests across 82 files. Both real PostgreSQL migration paths pass the production receipt validator against seven receipt cases each; this uses a psql adapter and is not hosted PostgREST evidence. The first unit run exposed Zod command normalization, and the first database run exposed a missing schedule in the synthetic task fixture. Both corrected checks passed. No migration, deployment or native installation.

## Web causal transport checkpoint

`c8c3e4c37fe59bd2bdb42e1a1ad532cf5de7547b`: **PASS_LOCAL**. Web and API now share the exact version-2 operation and receipt validator. The dormant transport sends the previously saved JSON unchanged, verifies account scope before sending, bounds the complete UTF-8 request to 256 KiB and response to 8 MiB, and retains cancellation/deadline protection while reading the body. HTTP failures distinguish retry from review without reflecting upstream diagnostics. It does not retire journal entries, enroll accounts, update projections or activate the application. Durable receipt application and native causal transport remain pending.

Focused checks: 24 passed. Full release checks: exit 0, 518 tests in 83 files. The initial full run failed because the sandbox denied loopback listen with EPERM; the permitted rerun passed. No SQL or native code changed; their prior checks were not rerun. No deployment or installation.

## Web durable causal receipt checkpoint

`0e1b639c75cb6d3bf16412adc5b0ce9d2b1d9a43`: **PASS_LOCAL**. The existing private account journal now persists exact wire requests before sending and rejects changes to their operation or epoch. A verified receipt and retirement of its matching accepted outbox entry commit atomically; original admissions, attempted bytes and receipt evidence remain. Rejected focus receipts retain their pending intent for resolution. Historical receipt projections cannot overwrite newer local counters/focus or advance the pull cursor. The combined pipeline retries interrupted requests unchanged and returns retained receipts without resending.

Final full release checks: exit 0, 524 tests in 84 files. Regression tests cover newer pending counters, rejected focus, immutable epoch/receipt evidence, interrupted network delivery, and rollback on storage failure. Initial type checking caught an optional IDB transaction store reference, corrected to the explicit store; the initial rejected-focus fixture violated the start epoch/action identity rule and was corrected. Failed and successful logs are retained. This remains dormant pending authenticated enrollment, authoritative projection integration and client activation; no native/SQL change or installation/deployment.

## Backup checksum integrity checkpoint

`314cb4a8f543c076329a0b626a65505d7e8fdd5e`: **PASS_LOCAL**. Backup canonicalization now includes unknown own `__proto__` fields instead of invoking the object prototype setter. A regression reproduced an altered audit field passing restore validation before the fix; afterward the altered backup is rejected before writes and an unchanged JSON round trip retains the field. Ordinary JSON checksums are unchanged. Older backups containing this field may fail validation because the original checksum omitted it; do not recompute their checksum as proof of original integrity. Preserve the source for explicit recovery.

Storage suite: 35 passed; full release checks: exit 0, 525 tests in 84 files. No native or SQL change; those suites were not rerun. Causal journal export/restore remains unimplemented and blocks activation. No installation or deployment.

## Causal backup export checkpoint

`d1888d93d4702c5b7c24ec372de23b25006b4437`: **PASS_LOCAL** for export preservation. Schema-5 backups include protected authority, original cutover preimages, exact request/receipt evidence, raw sync state, tracking mirror and uninterpreted current legacy WAL/fallback captures. All IndexedDB evidence is read in one transaction; later localStorage captures are retained as evidence, not admitted or replayed. A legacy tracking deletion cannot erase exported authority. Ordinary exports retain schema 4. Tagged JSON preserves undefined and own unknown fields; unsupported non-JSON structured-clone values cause explicit export failure rather than lossy output.

Restore into or from causal storage and causal self-repair stop before replacement until journal reconciliation is implemented. This is an explicit remaining activation blocker, not a completed recovery path. No existing data or queue is cleared. Focused storage/codec tests: 38 passed. Lint and full release checks: exit 0, 528 tests in 85 files. No native/SQL changes or reruns, deployment or installation.

## Fresh-account causal restore checkpoint

`01ab984aa0bab480807db337b3a702b51cc341fa`: **PASS_LOCAL** for restoring into an empty account. The importer clones and validates the bound schema-5 artifact before writes, checks exact request/receipt pairs and projection consistency, and restores all business collections, raw sync metadata and causal authority in one transaction. The original artifact, including unknown evidence and uninterpreted captures, remains archived under its checksum. Imported captures are not converted to executable WAL or newly identified actions. Generation, cursor, attempted bytes, accepted receipts, admissions and pending identities remain intact. Backup capture now also includes local recovery/deletion markers.

Both preflight and the write transaction reject existing account state or local captures. An already committed identical import is idempotent even after newer actions; it never rewinds them. A peer write between preflight and commit is preserved, and an injected final journal-write failure rolls back tasks, tracking and sync together. Retrying the restore and pending wire request retains their identities; accepted actions are not resent or counted twice. The storage fence may already have committed when a later restore write fails, but its preserved preimages remain intact and no imported projection or cursor commits.

Final focused tests: 42 passed; final full release checks: exit 0, 532 tests in 86 files. No native or SQL change; no native/database reruns, installation or deployment. Restoring into nonempty accounts, authenticated epoch/state reconciliation, native causal journals and application activation remain incomplete. This does not prove a rendered app restore journey or S2 acceptance.

## Authenticated causal capability checkpoint

`4247269b52b79db1f7e0276de7216771fab566ec` with additive migration `7d0af94e84b02a5e565e9b55cc1645f60eaac41f`: **PASS_LOCAL**. The service-only, stable SECURITY INVOKER discovery RPC returns the account epoch and causal revision without enrolling or changing an account. The authenticated GET endpoint selects only the middleware user UUID, validates the returned owner and shape, disables caching, and sanitizes failures. Responses explicitly retain `rolloutReady: false`. The Web reader bounds response bytes and cancellation/deadline handling; its durable binding rejects a different epoch or older revision and never changes projections, generation or pull cursor. Preparing wire requests now requires that binding. Existing attempted requests must retain their exact original epoch and JSON bytes.

Final full release checks: exit 0, 538 tests in 87 files. Both real PostgreSQL migration paths passed, including new privilege/non-enrollment assertions and existing receipt, conservation, locking and cursor suites. Migration/hash checks: 29; identifier checks: 22. The first identifier check caught the missing new migration filename entry; the additive ledger update passed the rerun. Advisors exited 0 with only the existing test-bootstrap pgcrypto-in-public warning. CLI lookup/network/telemetry and sandbox socket failures were resolved using the installed CLI with permitted access; the existing PostgreSQL server was verified running and was not restarted. The dedicated synthetic capability database was removed after validation.

No native change or rerun, live DDL, deployment or installation. Server enrollment, authoritative causal state pull, native journals and application activation remain incomplete. Discovery/binding is a prerequisite, not S2 acceptance or rollout readiness.

## Bounded causal history checkpoint

`f6268941d31aaded50799459fe8cb13547cf67bd` with additive migration `8e400b63602f310367fd1f4f61985e6ac680ece4`: **PASS_LOCAL**. Authenticated history reads return immutable cutover/action receipts one revision at a time, split into 49,152-byte chunks. Each chunk binds the account, epoch, revision, fixed through-revision, offset, entry length and SHA-256 hashes. The service-only stable SECURITY INVOKER RPC does not enroll accounts or change projections/cursors. Indexed revision lookup supports histories exceeding 1,000 actions without truncation; new actions leave previously anchored reads unchanged. The shared validator verifies chunk ordering, exact UTF-8 bytes, full hashes, cutover baselines and versioned action receipts before accepting a complete entry. The API disables caching and sanitizes errors.

Focused protocol/API checks: 11 passed. Full release checks: exit 0, 543 tests in 88 files. Both real PostgreSQL migration paths passed; synthetic transport tests retain all 1,002 entries and production validators reconstruct six real receipt entries in 13 chunks. This uses a local psql adapter, not hosted PostgREST. Migration/hash checks: 30; identifier checks: 22. Advisors exited 0 with the existing bootstrap pgcrypto-in-public warning. Initial sandbox runs failed because loopback listeners were denied; permitted reruns passed. Evidence retains those failures. The dedicated synthetic database was removed after validation.

The shared/API reader explicitly rejects individual entries above 16 MiB; evidence is retained for recovery, never truncated. There is no total history-entry-count cap. Durable partial-download storage, history application to client projections, native causal journals, server completion and activation remain incomplete. No native source changed or native checks reran; no installation, deployment or live DDL occurred. S2 remains BLOCKED and S3 is not authorized.

## Durable Web history and projection checkpoint

`93a40d60fad322e1e423d54dd196308b849a1d6d` plus downloader `2381aec3ff809ce18d82cbb0e7488e9a7f47aab8`: **PASS_LOCAL**. The protected account journal now retains verified partial chunks and their original horizon/offset. Reopening or schema-5 export/fresh restore resumes from that exact position. Completed entries retain their exact reconstructed bodies and hashes; download progress commits with evidence and never advances the ordinary sync cursor. Imported/resumed history is revalidated, including the complete contiguous revision set. Downloads use a 72 KiB response bound, per-request deadline and cancellation, and bounded work per call (32 chunks by default, configurable up to 1,024) without limiting retained revision count. A concurrent downloader cannot overwrite a winner; a concurrent local admission survives.

Application reconstructs every counter/focus/day transition from cutover through the downloaded horizon. Counter equations and every protected receipt projection must agree; the latest scalar snapshot alone is insufficient. Local counter events merge by immutable identity, preserving pending increments and both counter types. Focus replays pending commands with original target/parent identities on top of canonical history. A stale F pause cannot pause G or resurrect terminal F; pending/rejected commands and review-code history remain inspectable. Exact attempted requests and matching receipts alone permit outbox retirement. Tracking, private authority, retirement and generation commit atomically; tasks, notes, ordinary sync metadata/cursors and unknown local tracking fields remain intact. The original local projection/focus preimage is retained.

A conflicting preserved local cutover or baseline requires explicit legacy recovery, not automatic overwrite. History must cover retained accepted receipts before projection application; no cursor or epoch rewind is permitted. This path remains dormant pending active application coordination and rollout. It does not solve native causal journals, server completion, nonempty restore reconciliation or ambiguous legacy recovery.

Downloader full release: exit 0, 550 tests in 89 files. Projection full release: exit 0, 556 tests in 90 files. Focused combined tests: 13 passed; an additional rejected-receipt assertion subsequently passed the six-test projection suite. Both real PostgreSQL migration paths passed and exactly matched TypeScript replay of six actual receipt entries, including a rejected focus and day change. Initial projection type checking found an inferred tracking type missing the optional focus field; an explicit record type fixed it. No SQL migration or native source changed; no native checks, installation, deployment or live DDL.

## Atomic server completion checkpoint

`2d29a8dddb51aac3c5d41e61d68b4cb3f7e9532a`: **PASS_LOCAL** for the dormant server transaction, receipt validation and transport. Additive migration `20260908015740_s2_atomic_focus_completion.sql` introduces service-only SECURITY INVOKER completion. One immutable focus command binds one final task mutation and its supplied stats/progress/goal/habit/event effects, at most one member per collection type. Mutation identities lock before entities, tracking serializes causal commands, and publication retains the existing transaction-scoped ordering guarantee. Existing member receipts retain their exact payload/device/version/timestamp contract. Any conflicting member or final-write failure rolls back the entire operation. Identical completion retries return the same outer/member receipts; a fresh action/member identity cannot award an already completed task again. Rejected focus transitions carry no applied member results.

Final notes were also being truncated by the canonical task projection at 10,000 characters. The forward migration removes that truncation and replaces the old character constraint with an explicit 4 MiB UTF-8 limit; the compatibility adapter now preserves full notes. Existing notes remain unchanged. Oversize writes fail rather than clipping content.

Authenticated direct and staged endpoints use the middleware account UUID, validate every member receipt and sanitize errors. Web transport stages original saved bodies above 256 KiB using the existing 4 MiB envelope, preserves manifest/chunk/member identities across interruption, and bounds receipt reads to 16 MiB. SQL refuses any completion whose serialized history entry would exceed the existing 16 MiB history limit, rolling back its effects. History download/reassembly recognizes the new completion receipt. Ordinary Web projection application explicitly stops before applying a completion until its task/effect coordinator exists; it never applies terminal focus alone.

Final full release checks: exit 0, 564 tests in 92 files. Both complete PostgreSQL migration paths passed, including injected final-write rollback, effect-conflict rollback, duplicate event refusal, fresh-ID duplicate refusal, full Unicode canonical notes, simultaneous identical completion, atomic pre-commit visibility and committed cursor order. Actual SQL completion receipts pass the production TypeScript validator and reconstruct through four history chunks. This uses a local psql adapter, not hosted PostgREST. Static migration/hash checks: 31; identifiers: 22. Advisors exited 0 with the existing test-bootstrap pgcrypto warning; their final run preceded only the subsequent validation-only duplicate-collection guard.

CLI iteration first needed explicit local non-TLS connection configuration, then rejected multiple statements in a prepared query; psql applied the isolated draft successfully. The concurrency test harness initially parsed PostgreSQL booleans as JSON and then decoded multibyte stdout chunks separately; both harness issues were fixed and reruns passed. Failed evidence is retained; long synthetic fixture strings in one failure log are abbreviated with raw and exported SHA-256 hashes in the handover. The dedicated synthetic database was removed after checks.

**Remaining:** client durable completion admission/receipt handling and atomic application of all completion members; building every required business effect and enforcing the combined admission envelope before local success; native causal journals/transport; legacy and nonempty-restore reconciliation; active rollout. A member conflict remains an explicit recovery boundary. This does not prove live cross-client completion, mixed-version activation, or full S2 acceptance. No native changes/checks, installation, deployment or live DDL.

## Completion receipt publication guard

`72dd0a88b9b94e1c30c8a1522a4ca06f8319df0e`: **PASS_LOCAL**. The exported completion receipt validator now independently validates the operation's account scope, including restored rejected receipts, and requires strictly increasing member publication versions below the final tracking version. Sequence gaps remain valid. This matches the existing SQL transaction's member iteration and final tracking publication; no SQL or legacy receipt contract changed.

Focused completion tests: 8 passed. Full release checks: exit 0, 566 tests in 92 files. Both real PostgreSQL migration paths passed with actual completion receipts through the production validator. Initial restricted runs failed on loopback access (release: 59 failed, 507 passed; database could not connect); permitted reruns passed. No native checks, installation, deployment or live DDL. The Web completion coordinator remains unimplemented; S2 remains BLOCKED and S3 is not authorized.
