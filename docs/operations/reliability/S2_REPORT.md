# S2 implementation checkpoint

Stage acceptance: **BLOCKED — implementation continues. S3 is not permitted.**

Latest tested source: `6e15682d89089d974c6b5f98ca53deaed53e4bd8`. Native authenticated enrollment/history orchestration: **PASS_LOCAL** (171 native tests passed, one hosted test skipped; lint/debug build passed; 719 Web/server tests and release gate passed). Native projection/acknowledgment, UI/completion, macOS and recovery remain incomplete. S3 remains blocked.

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

## Web atomic completion admission and receipt checkpoint

`0b87bcddd5f465f106669a8214ef609804988988`: **PASS_LOCAL**. The dormant Web coordinator captures intent once, then reads the current focus parent and all business collections in one IndexedDB transaction. It derives final task notes/status, day statistics, progress, linked goal/habit effects and a task event from that state. All changed collections, terminal focus, original affected preimages, admission, stable member identities, pending logical action, generation and version reservations commit together. An explicit empty final description is preserved as an edit; absence retains existing notes. Existing unknown fields, unrelated records, planning confirmation and both tracking counters remain intact. Repeated identities reuse the admission; concurrent distinct taps award once and retain rejected intent notes.

Each new member passes the existing 3 MiB record limit. The entire completion reserves its eventual dependency version overhead and must fit the 4 MiB UTF-8 envelope before local success. Missing/ambiguous task or effect state, unresolved affected conflicts, unmaterialized captures/fallbacks and ambiguous predecessor versions fail without a partial completion. Earlier ordinary edits can drain while a completion is offline. Later edits depend on reserved completion members and cannot be selected or marked attempted early. Completion members never enter the ordinary push queue. Pull pages touching reserved effects pause without changing records or cursor.

Preparing a request waits for exact predecessor receipts, including local focus commands and earlier completion members, then saves immutable wire bytes. Response loss retries those same bytes. Receipt commit archives the complete versioned acknowledgment and atomically releases only matching reservations, fills unattempted successor base versions, and retires the accepted logical action. Original admissions, notes/preimages, requests and receipts remain retained. Rejected receipts preserve every reservation and pending action for recovery. Historical receipt projections never replace newer local focus or task edits, and receipt commits never advance the ordinary pull cursor.

Schema-5 restore now checks completion request/admission/receipt/dependency/reservation binding and pending effect projections before writes. Actual export into a fresh database resumes the original request and does not award twice. Epoch discovery also checks saved completion requests. The existing history-only projection applier explicitly refuses pending completions as well as downloaded completion entries; applying terminal focus separately from task effects remains prohibited.

Final full release checks: exit 0, **581 tests in 94 files**. Both final real PostgreSQL migration paths passed: the production Web admission prepares six effects, PostgreSQL commits them, the test loses the response, and a new local connection retries the original request and retires it from exact receipts. Server effects and full canonical Unicode notes match; the task award remains one and the local cursor is unchanged. This is a local psql adapter, not hosted PostgREST or browser rendering. Focused integration passed 55 tests; later focused completion checks passed 14 tests before the final additional predecessor regression was included in the full release run. Initial TypeScript checks found three narrowing errors; they were fixed and final checks passed.

**Remaining:** atomic application of downloaded completion members and pending completion reconciliation; active Web UI/storage/sync coordination; native causal journals and completion integration; legacy/nonempty restore recovery; mixed-version activation. Reservations protect current protocol code but are not an old-JavaScript write fence for all business stores. This checkpoint remains dormant and does not establish cross-client rollout readiness. S2 remains BLOCKED; S3 is not authorized. No migration/native changes, native reruns, installation, deployment or live DDL.

## Atomic Web completion history application checkpoint

`f3fa120c106c14dfe58315c67e8f57c44a1fb41c`: **PASS_LOCAL**. Full history replay now validates completion focus transitions together with their member receipts, protected counters and immutable identities. Application commits all affected task/effect collections, terminal focus, exact local acknowledgments, retained preimages, per-entity versions and generations in one IndexedDB transaction. It never advances the ordinary sync cursor. Application proofs bind the original action to the exact retained history revision/hash. Reapplying a horizon is idempotent.

A versioned replica can catch up from the authoritative full completion receipt without retrieving intermediate snapshots. An empty replica can hydrate the receipt's effects without inventing unrelated records. Newer represented records and pending local completions keep their current projections. A matching original attempted completion request permits receipt retirement through the same validator used by direct responses; receiving an accepted peer action does not manufacture a local attempted request. Pending focus and completion commands replay in parent order, including completion F → start G → completion G. Their original task preimages establish eligibility for earlier commands in that chain. Completed F never revives after G starts.

Unmaterialized captures, unversioned local data, overlapping pending edits, inconsistent evidence and rejected/incompatible local completions retain all business state and cursor. Recoverable overlaps and causal rejections receive a separate durable review after the projection transaction aborts; invalid proofs fail closed. Once the underlying condition is resolved, application can resume and the review history remains. Unrelated records and planning confirmation stay unchanged; replaced record preimages remain retained. Schema-5 restore verifies application proofs and their retained history hashes before database changes. The receipt boundary additionally requires every member publication version to follow its submitted base version.

Final full release checks: exit 0, **597 tests in 95 files**. Focused integration: 47 tests passed in five files. Both real PostgreSQL migration paths passed. The extended harness uses production Web admission/transport and a second isolated fake-IndexedDB replica: it downloads five real SQL history chunks, refuses application before the horizon is complete, atomically installs all six effects and focus, and replays without change. Full notes and both tracking counters match, while the ordinary cursor stays unchanged. This is local PostgreSQL with a psql adapter, not hosted PostgREST, native execution or a rendered browser journey.

Additional tests cover four injected final-write failures, a local edit arriving during hash verification, lost-response acknowledgment without overwriting newer notes/session G, a restored admission without attempted bytes, two interleaved local completions, versioned catch-up, empty hydration, durable recovery review/resume, rejected completion preservation, and actual schema-5 restore. An earlier existing test expected the old refusal gate and failed when the new applier correctly replayed the pending completion; it was updated to assert preserved effects and terminal focus, and the full suite passed.

**Remaining:** active Web UI/storage/sync integration and the old-JavaScript business-store fence; native causal journals, transport and completion integration; legacy and nonempty restore reconciliation and recovery actions; mixed-version activation and final platform acceptance. These library paths are not activated in the installed application. S2 remains BLOCKED; S3 is not authorized. No native changes/checks, migration changes, installation, deployment or live DDL.


## Web business-store compatibility fence checkpoint

`253bc777ff0c8d40a671adda02ca76bc9275d456`: **PASS_LOCAL**. An explicit, dormant IndexedDB upgrade preserves every existing key and structured-clone value in all 14 non-tracking account stores, including sync requests/receipts, in private `causal_business` authority. The same versionchange transaction replaces legacy stores with inline-key mirrors. Old explicit-key puts fail after reopening; supported old deletes/clears remove only mirrors. Tracking retains its existing private authority. Historical snapshots remain untouched. Original preimages, malformed values, unknown fields, composite keys and present-undefined values survive. All store copies roll back together if any preservation write fails. Concurrent/repeated cutover does not recopy deleted mirrors or replace evidence.

Shared transaction accessors read private authority and commit authoritative values plus mirrors together. Causal focus admission, completion admission/request/receipt handling and history projection now use these accessors. The existing unfenced library fixtures remain supported. Authoritative deletion keeps an absent marker and cutover evidence; missing authority behind a retained mirror fails closed. New durable store/key names are recorded in the identifier ledger. This is a compatibility fence for supported older clients, not a security boundary against arbitrary same-origin code.

Full release checks: exit 0, **620 tests in 96 files**. Focused tests: 51 passed in three files. They include per-store injected migration failures, reopened legacy puts/deletes/clears, concurrent upgrades, final mirror-write rollback and actual completion admission/history replay with the fence enabled, including lost-response recovery while retaining newer notes/session G. Static migration checks (31), SQL hashes (31), Room hashes (8) and identifier checks (24) passed. Initial lint found a transaction-mode typing error in the upgrade validator; it was corrected before the passing checks. Evidence logs and SHA-256 hashes are in the JSON handover. No PostgreSQL/native/browser-engine execution was repeated for this IndexedDB-only change; fake-indexeddb is not rendered-browser or cross-client proof.

**Remaining:** route active ordinary storage, backup/restore, account lifecycle and sync through authority; recover retained legacy captures without treating them as causal admissions; then wire active Web commands. The existing backup exporter explicitly refuses a business-fenced database until it can preserve the new authority, preventing an incomplete export. No application path invokes this cutover yet. Native causal integration, historical/nonempty restore recovery, mixed-version activation and final platform acceptance remain. S2 is BLOCKED; S3 is not permitted. No installed application was changed or deployed.


## Authoritative business backup and restore

`a16a227890f7d72395e61b64f69219c31f79b444`: **PASS_LOCAL**. Schema 6 preserves all 14 business-store authority records, exact sync values, original cutover preimages, absent markers, present-undefined values, unknown fields and mirror discrepancies with the existing tagged encoding. The outer collections are compatibility views; restore uses validated authority. Validation checks the account, full store manifest, current projections and exact sync evidence before schema/data writes. Unsupported tagged values fail explicitly. Schema 5 remains supported, including import into an empty account in a database already fenced for another account.

Restore archives the complete original artifact and captures. Repeating the same restore never rewinds later local changes. Nonempty private authority, including absent markers behind missing mirrors, refuses overwrite. A final business insert failure rolls back all restored members; retry uses the same artifact. The existing exporter refusal has been removed because complete business authority is now included. Pending completion requests survive actual export/import byte-for-byte; both pending and applied completion evidence continue through their original validators.

Release checks: exit 0, 631 tests in 97 files. Focused backup/completion checks: 45 passed. These checks used fake-indexeddb; the subsequent ordinary-storage checkpoint adds Chromium/WebKit evidence for pending completion restore. Nonempty-account reconciliation and interpretation of retained late captures remain separate recovery work.

## Ordinary storage integration and browser verification

`a78701b19f1a2c5b42002cfee2d08fd0457b31da`: **PASS_LOCAL**. Ordinary reads, local commits, receipt handling, inbound pages, conflict application, initialization and migrations now include private authority in their existing transactions. Reads remain correct after old mirror deletes. Business values, sync evidence and mirrors commit together. Tracking snapshots cannot change the protected day/counter/focus fields, initializers cannot silently replace authoritative absence, legacy account-key migration cannot rebind causal identity, and generic record APIs cannot delete private journals. Ordinary cloud seeding skips causal tracking.

New captures carry a compatibility marker, and their queued mutation payloads must match their captured values and entity scope. The marker is not a security credential. Untagged legacy captures, inconsistent captures and groups containing causal tracking changes are retained verbatim for review without applying any member or inventing a counter delta. Exact envelopes and journal identities commit together before normal WAL retirement. Fallback copies receive the same explicit review treatment. Independent ordinary notes can still commit. Pending reviews remain visible in pending/error state and prevent completion from bypassing unresolved captures. Sync updates preserve existing opaque fields and completion reservations.

Final release checks: exit 0, **639 tests in 98 files**; production artifacts exclude both S1 and S2 test harnesses. Final combined browser checks: **54 passed** in Chromium/WebKit (42 S1 ownership/interaction journeys and 12 S2 authority/upgrade journeys). The S2 journeys prove that an older connection delays upgrade while its last committed edit is retained, old explicit-key writes fail, deleted mirrors do not erase authority, and a pending completion restores into a fresh browser profile with identical request bytes and one award. The completion receipt is synthetic; this does not establish hosted/server acceptance. Static migration/hash/Room/identifier checks passed (31/31/8/24).

Iteration evidence is retained. One unit assertion initially compared local attempted-at metadata instead of the actual wire request; it now checks the production wire serialization. Two browser restore checks correctly refused existing recovery copies in the same profile; the fixture now uses a fresh profile without clearing the source. Four S1 browser checks used the old unpaged conflict mock; updating it to the implemented paginated contract restored all 42 passes. No validator or failing gate was relaxed.

**Remaining:** typed causal UI actions and day handling; account enrollment/activation and causal synchronization orchestration, including completion-safe ordinary pull ordering; native causal journals/transport/completion; legacy and nonempty restore recovery and review actions; mixed-version activation and final acceptance. Ordinary tracking snapshots deliberately refuse protected changes until the causal command path handles them. Fresh accounts behind an existing global fence also require an explicit initialization/enrollment path. The installed applications remain unchanged. No SQL/native changes, PostgreSQL/native reruns, live configuration, installation or deployment occurred in this checkpoint.


## Web day intent journal checkpoint

`c3ef3becf1bd0fd2a1455455df858e86dd3a576f`: **PASS_LOCAL**. Day establish/select commands are retained with stable action identity, account scope and local generation order in one private journal transaction. Equal-clock distinct actions remain distinct; retries reuse admission. Unknown days do not acquire invented zero baselines, and admission alone leaves the visible date, counters, focus and unknown fields intact. Receipt and downloaded-history paths now distinguish day commands from counter deltas. Only exact attempted request/receipt evidence permits retirement; original admission and wire bytes remain archived. Restore and application reject inconsistent day identities, order and pending payloads.

Validation: `npm run verify:release`, exit 0, 645 tests in 99 files plus production builds and artifact checks. Focused day/receipt/projection tests: exit 0, 18 tests. The first release attempt was interrupted after loopback binding failed with sandbox EPERM; the permitted rerun passed. Initial type checking required the existing multi-store IndexedDB transaction typing. A recovery-test fixture initially changed shared references together; replacing only the pending entry correctly tested substitution and passed. Sanitized final logs and hashes are in the JSON checkpoint.

This is a dormant journal building block. Pending day selection projection, dependent offline increments, UI wiring, enrollment and synchronization orchestration remain unfinished, along with native and recovery acceptance. No SQL migration, native installation, live configuration or deployment. Overall S2 remains **BLOCKED** for acceptance; S3 is not permitted.


## Offline day and counter checkpoint

`69c9126b968c9b3a7997ab137d98d425d27df5a9`: **PASS_LOCAL**. Established days project locally in the same transaction as selection admission. Unknown days retain the last provable date/counts and an explicit waiting status. Counter actions can be captured against a durably admitted unknown day, but first transport waits for its baseline. Complete history installs verified baseline evidence and merges the pending actions once. Pending selection order excludes older actions already superseded by a newer represented local selection; their evidence is retained.

Full release checks passed: 649 tests in 99 files, type checking and production builds. Real Chromium/WebKit storage tests passed 14/14, including reload and retry of an unknown-day increment without a guessed zero. A final production build and artifact scan passed after adding the test-only harness entrypoint. Commands, sanitized logs and checksums are in the JSON checkpoint. No failed checks occurred in this checkpoint.

Active application wiring, atomic business-counter actions, ordered transport/enrollment, native integration and recovery acceptance remain unfinished. No SQL or native changes, installation, live configuration or deployment. S2 acceptance remains **BLOCKED**; S3 remains prohibited.


## Rendered Web focus-control checkpoint

`55302ad63ce0e242fc9c8d232a029ccb7500e9b9`: **PASS_LOCAL**. Existing fenced accounts now route rendered start/pause/resume/stop/add-time controls through the causal coordinator. The timer passes its observed target explicitly; the transaction derives epoch and actual parent and retains the original control in the immutable command. Rapid paused add-time controls apply both extensions, with one explicit resume. Delayed handlers never repaint their old result over committed state. Causal queues participate in pending status, and fenced day hydration uses the retained day command instead of a scalar reset. Legacy accounts retain their existing callback path.

The real interaction test found the decorative timer SVG intercepting Edit Duration clicks. The SVG now ignores pointer events. The test clicks the actual timer and add-time controls after synthetic account cutover, verifies the same focus identity, a +300 extension, causal outbox entries and unchanged ordinary tracking queue.

Validation: final `npm run verify:release` exit 0, 653 tests in 99 files; combined S1/S2 real Chromium/WebKit journeys exit 0, 58 tests; final production build/artifact scans exit 0. Initial browser attempts failed first on omitted fixture fence ordering, then on the actual SVG click obstruction; both are recorded and corrected. Sanitized logs/hashes are in the JSON checkpoint.

This does not activate cutover or complete S2. Completion and counter business-effect UI paths, enrollment, causal network scheduling, native integration, recovery and mixed-version acceptance remain. No SQL/native source change, PostgreSQL/native rerun, installation, live configuration or deployment. S2 acceptance remains **BLOCKED**, with no permitted S3 handoff.


## Rendered focus-completion checkpoint

`889bcd01e47c5184efd36fa1aac62b55f6fa20ba`: **PASS_LOCAL**. Fenced active/paused focus completion now uses the atomic task/effects coordinator through the actual App and checkout callbacks. The transaction derives the original target epoch and actual parent, retaining the UI control alongside immutable completion evidence. Checkout holds its original task/focus/notes; repeated matching attempts reuse action identity, duration and day/timezone attribution. A failed write keeps checkout open. Sounds, celebration and break setup occur only after successful durable admission. Explicit empty final descriptions and unknown progress fields are preserved by the ordinary fallback as well.

The real browser test injects failure only at the terminal-focus write. It verifies that task completion and effects roll back while separately saved final notes remain, then retries the identical capture and observes exactly one completion admission, outbox item and task event. Initial testing exposed App dropping the returned promise and observed target; the complete callback chain now forwards and awaits both.

Validation: full release exit 0, 654 tests in 99 files; combined S1/S2 Chromium/WebKit journeys exit 0, 60 tests; final production build/artifact scans exit 0. Six sanitized logs and hashes are in the JSON checkpoint. Remote fetch recovered from one transient TLS error.

Non-focus task completion still uses the ordinary path and requires its concurrency boundary review. Counter business effects, enrollment/scheduling, native integration, recovery and mixed-version acceptance remain incomplete. No SQL/native change or rerun, installation, live configuration or deployment. Overall S2 acceptance remains **BLOCKED** and S3 is not permitted.


## Web reschedule business checkpoint

`f66bc40c77b12991de3ab63f4b76377e3d6801dc`: **PASS_LOCAL**. Fenced Web rescheduling derives the current task and postponement increment inside one transaction. Task changes, the existing ordinary mutation queue/journal, the immutable reschedule admission and its child counter event commit together. Concurrent moves use their actual task parent, existing frog commitments remain enforced, and retries do not duplicate either effect. A delayed action retains its captured day; an unknown baseline retains the event without inventing a visible count.

The dialog waits for durable admission, stays open on failure and blocks simultaneous submissions. Unit regressions cover concurrent parents, frog rejection, full rollback, delayed/unknown-day attribution and retries after unrelated counter activity. The real browser test opens the planning drag/drop reschedule dialog, injects a failed write, then verifies identical retry capture and one resulting task/counter admission.

Validation: full release exit 0, 660 tests in 100 files; combined S1/S2 Chromium/WebKit journeys exit 0, 62 tests; final production build and artifact checks exit 0. Three sanitized logs and SHA-256 hashes are recorded in the JSON handover. Initial sandbox loopback failures and the corrected browser fixture are recorded as failed attempts, not passes.

Planning-visit penalty admission, causal scheduling/enrollment, non-focus completion concurrency, native integration and full recovery/mixed-version acceptance remain incomplete. No SQL/native changes or reruns, installation, live configuration or deployment. S2 remains **BLOCKED** and S3 is not permitted.


## Web planning business checkpoint

`b2eda61d08a43f16d92892571c3398832478d9de`: **PASS_LOCAL**. Planning visits now bind immutable user intent, a child counter event, the observed counter-event frontier and the captured penalty setting. Known-baseline counter/progress/ordinary-queue/effect updates commit together. Unknown-baseline visits remain durable; verified history later settles their original observed frontiers atomically, without using yesterday's count or later events to change an earlier threshold decision.

The sixth observed visit warns, later visits preserve off/gentle/classic penalties, and retries cannot charge twice. The rendered navigation waits for durable admission and retains failed intent for retry. Warning copy accurately states six visits and reflects disabled penalties. Tests cover concurrent equal-time visits, all penalty modes, rollback, delayed baseline/history application, replay and changed evidence. The real browser journey proves warning six, rollback of a failed seventh visit and exactly one 25-XP gentle penalty on identical retry.

Validation: full release exit 0, 668 tests in 101 files; combined S1/S2 real Chromium/WebKit journeys exit 0, 64 tests; final production build/artifact checks exit 0. Four sanitized logs/hashes and iterative failures are recorded in the JSON handover.

Causal scheduling/enrollment, non-focus completion concurrency, native integration and comprehensive recovery/mixed-version acceptance remain open. No SQL/native changes or reruns, installation, live configuration or deployment. S2 remains **BLOCKED** and S3 is not permitted.


## Fenced new-account initialization checkpoint

`9564d6147c5f7e3b3a6657bffd89dc6594ffc612`: **PASS_LOCAL**. A new local UUID account can initialize behind an existing database-wide fence. Tracking authority, mirror and one day-selection intent commit atomically; original tracking absence is retained, and the account waits for a verified baseline. Recorded absence, orphan mirrors, retained copies, nonzero defaults and legacy imports are never replaced by defaults.

The legacy email lookup now permits hydration only when there is no source evidence to migrate. Actual rebinding remains blocked. A real-browser journey creates a second UUID account with a distinct synthetic email, adds a task and captures planning/focus offline; the first account's tasks and metadata remain unchanged. Unit tests also cover concurrent initializers, mirror-write rollback and retained-source guards.

Validation: full release exit 0, 673 tests in 101 files; combined S1/S2 Chromium/WebKit journeys exit 0, 66 tests; final production build/artifact checks exit 0. Four sanitized logs and hashes are in the JSON checkpoint.

Server enrollment must still reconcile preserved local absence with verified history. Causal scheduling, native integration, non-focus completion concurrency and comprehensive recovery/mixed-version acceptance remain incomplete. No SQL/native changes or reruns, installation, live configuration or deployment. Overall S2 remains **BLOCKED**, with no S3 handoff.


## Enrolled Web cloud-queue checkpoint

`78212f107d26dbf0ac10fea3174f54f177c565a2`: **PASS_LOCAL**. The cloud loop now discovers the existing epoch, verifies bounded history, drains ordinary predecessors and sends saved day/focus/counter/completion operations. Focus follows actual parents; attempted request bytes and exact receipt validation remain intact. Durable UI admissions wake synchronization, and pending causal actions prevent a synced status.

An ordinary tracking pull racing a local or peer action retains its cursor and retries after verified history refresh. Three refresh attempts bound the loop; continued mismatch remains retryable without installing unverified protected fields. Five synthetic HTTP tests cover serial +300/+120 focus extensions, counter receipt loss/recovery, peer and local pull races, and an unverified tracking projection. These exercise real IndexedDB coordinators and serializers, not a hosted database.

Validation: full release exit 0, 678 tests in 102 files; existing S1/S2 Chromium/WebKit journeys exit 0, 66 tests; final production build/artifact checks exit 0. Three sanitized logs and hashes are recorded in the JSON checkpoint. Corrected fixture/type/path failures and the initial sandbox loopback failure are recorded separately.

Enrollment, new-account history reconciliation, native integration, non-focus completion concurrency and comprehensive recovery/mixed-version acceptance remain incomplete. No SQL/native changes or reruns, installation, live configuration or deployment. Overall S2 remains **BLOCKED**, with no S3 handoff.


## Explicit enrollment checkpoint

`da914a649c3bb90f506a4cdd85f788e8869817cf`: **PASS_LOCAL**. Exact cutover requests persist before transport. Replays reuse their original bytes; receipt archival never changes pending actions, tracking projections or cursors. Capability binding and backup import validate retained enrollment proof. Competing identities serialize, failed writes roll back, and unknown baseline fields remain preserved.

Direct and staged authenticated HTTP paths call the existing compare-and-establish SQL function. Changed baselines require review; interrupted requests retain their identity. The existing staging protocol supports up to 4 MiB, with UTF-8 size validation before new admission. Tests cover lost responses, competing requests, receipt-write failure, backup validation, multibyte uploads and mismatched chunk acknowledgments.

Validation: full release exit 0, 697 tests in 103 files, including production build and artifact checks. The JSON handover records the sanitized log and checksum. HTTP database responses are synthetic; hosted enrollment is not proven.

Automatic enrollment selection, absent/divergent local baseline reconciliation, native integration, non-focus completion concurrency and comprehensive legacy recovery/mixed-version acceptance remain incomplete. No SQL changes, native/browser reruns, installation or deployment. S2 remains **BLOCKED**, and S3 is not permitted.


## Automatic known-baseline enrollment checkpoint

`915631c423720703a237a70c8b3dc41569c690d0`: **PASS_LOCAL**. Known-version preserved tracking now establishes its exact enrollment before pending commands are sent. Lost enrollment responses recover from verified revision-zero history. A receipt-backed binding retains the complete original local baseline, including unknown audit fields and historical identities, separately from the exact canonical baseline. Historical identities cannot become new deltas. Missing or divergent evidence still requires recovery.

Validation: full release exit 0, 700 tests in 103 files, including production build and artifact checks. The initial sandbox run failed on loopback `listen EPERM`; the permitted rerun passed. The JSON handover records the sanitized log and checksum. HTTP responses remain synthetic.

Absent/divergent account baseline reconciliation, native integration, non-focus completion concurrency and comprehensive legacy recovery/mixed-version acceptance remain incomplete. No SQL changes, native/browser reruns, installation, live configuration or deployment. Overall S2 remains **BLOCKED**; S3 is not permitted.


## Fresh local account history checkpoint

`6428cd6f90fa8aa007a02a6e3376356f0d6df03a`: **PASS_LOCAL**. A newly initialized local account can join verified enrolled server history. The original local absence, zero defaults and day intent remain immutable; a separate revision-zero history binding records the server baseline. Pending increments retain identity and apply after verified baseline establishment. Initialization evidence is checked on reads and backup imports.

The synthetic cloud test proves server 27/3 plus a queued local increment becomes 28/3 without changing server focus; replay sends no duplicate actions. Altered initial counts, day and absence are rejected without changing stored authority. Full release exit 0: 704 tests across 103 files, including build/artifact checks. Log and checksum are in the JSON handover.

Server-absent enrollment, divergent legacy reconciliation, native integration, non-focus completion concurrency and comprehensive recovery/mixed-version acceptance remain incomplete. No SQL changes, native/browser reruns, installation or deployment. Overall S2 remains **BLOCKED**, with no S3 handoff.


## Atomic server initialization checkpoint

`a2b5cca0da80c7c804ad607e080d4bdb448270d9`: **PASS_LOCAL**. Fresh local accounts retain one exact initialization request before transport. The new service-only transaction selects existing canonical tracking unchanged, or creates zero defaults only when both the record and historical tracking evidence are absent. Creation and cutover commit together. Its outer receipt binds the initialization request; the nested cutover receipt keeps its existing exact-record contract. Competing attempts remain retained while verified history identifies the winning epoch.

Migration `20260908065315_s2_causal_account_initialization.sql` is additive and hash-pinned; only its new filename was added to the identifier ledger. Existing migration files and legacy receipts remain unchanged. Missing historical tracking, tombstones, malformed defaults and identity collisions still require recovery. Rollout readiness remains false.

Validation: full release exit 0, 711 tests in 103 files; full empty/upgrade PostgreSQL matrix exit 0; migrations, migration hashes, Room hashes and identifiers exit 0. Real PostgreSQL tests prove concurrent exact retries, rollback and committed cursor ordering. Production API validators and TypeScript history replay consume real database receipts for both new and legacy accounts. Web tests cover lost responses, failed receipt writes, backup validation and a competing initializer without duplicating a queued increment. Three sanitized logs and checksums are recorded in the JSON handover.

Hosted PostgREST is **NOT MEASURED**. Divergent legacy reconciliation, native integration, non-focus completion concurrency and comprehensive recovery/mixed-version acceptance remain incomplete. No native/browser reruns, installation, live configuration or deployment. Overall S2 remains **BLOCKED**, with no S3 handoff.


## Android causal journal checkpoint `9b0022fc2eef7f4f3cb46a56d02b4866332ddb11`

Room 9 adds a private account journal. Focus admission reads its actual parent and atomically persists intent, command, outcome, projection and pending command. Ordinary tracking changes and conflict deletion are fenced after explicit preparation. Legacy outbox bytes remain captured and retained. Backup schema 5 carries exact journal bytes; incompatible or divergent journals require recovery. Existing backup schemas remain readable.

Six focused Room tests cover serial extensions, exact retries, failed commits, snapshot fences, account/mirror mismatch, encrypted fresh-database restore and missing-command corruption. Full native gate: 155 passed, zero failed, one hosted-transport test skipped; lint and debug APK build passed. Command: `env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./android-native/gradlew -p android-native :app:testProductionDebugUnitTest :app:lintProductionDebug :app:assembleProductionDebug --offline -PgoalflowSkipSigning=true` (exit 0). Room hashes: 9 checked; durable identifiers: 24 checked. Evidence: `evidence/s2-native-causal-store.log`. No native installation, hosted test or production activation occurred. Native network integration, counters/day handling and atomic business completion are still required.


## Android counter/day checkpoint `cf04ba5dd107b2154d43b44ab5b44bbe9c40d4b6`

Stable account/actor/action IDs, day, timezone and millisecond timestamps are persisted with each counter event. Distinct equal-time actions count independently; retrying the same event changes nothing. Focus, day and counter IDs share an exclusion check. The complete admission sequence detects missing evidence even for a pending event that has no visible projection yet.

Day commands retain requested date/zone. Unknown days preserve the previous proven tracking projection and focus, while explicitly admitted day events wait for a verified baseline. No zero baseline is inferred. Nine focused Room cases are included in the full 158-pass suite; one hosted test is skipped. Lint and debug build passed; Room 9 hashes and 24 durable identifiers passed. Command: `env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./android-native/gradlew -p android-native :app:testProductionDebugUnitTest :app:lintProductionDebug :app:assembleProductionDebug --offline -PgoalflowSkipSigning=true`, exit 0. Evidence: `evidence/s2-native-counter-day.log`. Native server history and receipt integration, causal completion and UI activation remain unimplemented; no deployment or installation occurred.


## Android exact receipt checkpoint `9757d7c230af7f0a2a05998a705a66793babc4d7`

The native version-two action boundary validates exact operation identity, account/epoch, record identity/revisions, and focus/counter/day outcome constraints. It returns original JSON evidence without timestamp rewriting. One-attempt transport sends the saved request string verbatim, enforces the 256 KiB UTF-8 body limit and 8 MiB accepted response limit, and classifies retryable HTTP failures without exposing server diagnostics. The caller remains responsible for authentication binding, durable attempted bytes and atomic receipt/history persistence.

Shared TypeScript/Kotlin fixtures cover focus, counter and day receipts, altered operation/account/revision and missing tombstone proof. Native tests cover identical request retries, microsecond receipt timestamps, multibyte oversize rejection and HTTP failures. Full native command `env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./android-native/gradlew -p android-native :app:testProductionDebugUnitTest :app:lintProductionDebug :app:assembleProductionDebug --offline -PgoalflowSkipSigning=true` exited 0: 161 passed, one hosted test skipped; lint/debug build passed. `npm run verify:release` passed 714 tests after permitting loopback. The first sandbox run failed with reproduced `listen EPERM 127.0.0.1`; no validator was weakened. Logs: `evidence/s2-native-receipts-android.log` and `evidence/s2-native-receipts-release.log`. No deployment, live sync or installation is claimed.


## Native history checkpoint `c8f8c7a93c7d4c4109a714319e7a6fb3d2d9916e`

Android validates 49152-byte chunks with fixed account/epoch/revision/frontier/offset, canonical base64, per-chunk and whole-entry SHA-256, a 16 MiB per-entry limit and strict UTF-8. Complete entries validate cutover, ordinary actions and atomic completion receipts. Completion validation preserves exact member payloads and legacy millisecond timestamp equality, including final notes, ordered committed versions and tracking publication after its members.

Room stores partial chunks and exact complete entry bodies. It revalidates saved evidence on read/import, requires consecutive revisions, and cannot replace a pinned partial manifest. A failed commit leaves download position unchanged. Download never changes tracking, ordinary cursors or pending commands. Tests exercise actual Room resume, failed commit, encrypted backup retention and missing-entry corruption, plus shared cutover/focus/counter/day/completion fixtures and multibyte chunk assembly.

Full native command `env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./android-native/gradlew -p android-native :app:testProductionDebugUnitTest :app:lintProductionDebug :app:assembleProductionDebug --offline -PgoalflowSkipSigning=true` exited 0: 163 passed, one hosted test skipped; lint/debug build passed. `npm run verify:release` exited 0 with 716 passed tests. Room hashes 9 and identifiers 24 passed. Evidence: `evidence/s2-native-history-android.log`, `evidence/s2-native-history-release.log`. Automatic enrollment/download integration, authoritative replay and exact receipt retirement remain required; no hosted or installed-app acceptance is claimed.


## Native replay checkpoint `01acdbaa31cff8bc204ff27c5fd62b8d2f46b218`

Native replay now reconstructs the complete downloaded prefix from cutover through focus, counter, day and completion operations. It compares derived outcomes/protected projections and rejects duplicate action/member identities, rewritten baselines and invented increments. Room checks this replay before advancing a completed download revision and when reopening/importing retained history. A correctly hashed but counter-inconsistent entry leaves the prior Room journal and download position intact. Projection application and queue retirement are still separate unfinished work.

Review also closed a Web replay gap: a new day baseline could reuse the cutover, another baseline or an accepted completion member identity. Web and Android now reject these collisions; a shared fixture specifically covers cutover reuse. Shared sequential history proves consistent counter/focus/completion/day reconstruction.

Final native command `env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./android-native/gradlew -p android-native :app:testProductionDebugUnitTest :app:lintProductionDebug :app:assembleProductionDebug --offline -PgoalflowSkipSigning=true`: exit 0, 167 passed, one hosted test skipped; lint/debug build passed. `env VERIFY_PORT=54173 npm run verify:release`: exit 0, 719 tests passed. The default-port run failed liveness because port 4173 served an unrelated Python HTTP 404; it was left untouched. Room hashes 9 and identifiers 24 passed. Evidence: `evidence/s2-native-replay-android.log`, `evidence/s2-native-replay-release.log`. No deployment or installation occurred.


## Native enrollment checkpoint `6e15682d89089d974c6b5f98ca53deaed53e4bd8`

The explicit `synchronizeCausalEvidence` engine entrypoint now verifies the server account and uses existing in-flight session checks and retries. Room saves one immutable initialization/cutover request before HTTP. Known cutover uses only preserved pre-command payload and an unambiguous retained server version. Fresh initialization retains zero local defaults separately from a selected existing server baseline. Exact enrollment receipts, capability epochs and monotonic history frontiers are validated and retained. Large cutovers use the existing staged-upload protocol; partial history resumes before a later frontier is downloaded. No ordinary cursor, tracking projection or pending action is retired by this evidence path.

Four production-engine/Room tests with a synthetic HTTP backend prove lost-response retry bytes, pending-counter preservation, large staged cutover/history, fresh-local existing-server selection and session-change rejection. Tamper checks reject changed capability epochs, created-record versions and retained cutover versions. These are native unit tests, not hosted evidence. Full native command `env JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./android-native/gradlew -p android-native :app:testProductionDebugUnitTest :app:lintProductionDebug :app:assembleProductionDebug --offline -PgoalflowSkipSigning=true` exited 0 with 171 passed and one hosted test skipped; lint/debug build passed. `env VERIFY_PORT=54173 npm run verify:release` passed 719 tests and all release checks. Room hashes 9 and identifiers 24 passed. Logs: `evidence/s2-native-enrollment-android.log`, `evidence/s2-native-enrollment-release.log`. No deployment or installation occurred.
