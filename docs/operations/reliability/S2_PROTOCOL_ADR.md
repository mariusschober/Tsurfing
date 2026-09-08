# S2 causal actions and lossless counters

Status: design in implementation; not rollout approval or acceptance evidence.
Baseline: S1 tested `09245261b6174ec878f0296ca61682c603f54304`, integrated
through `85f1c68e46c2577bb56d3cf5dbebb51fdb40673d`; S1.2 source correction
`262fa6e96a8cba7d0ebbb6843b9f8a0131b4cb7d`, handover `8f3c863`.

## Representation decision

| Option | Benefit | Failure boundary |
|---|---|---|
| Tracking envelope with operation metadata | Small wire change | Old writers replace metadata; whole-record receipts cannot accept a merge |
| Dedicated public focus/counter entities | Clear ownership | Old clients reject unknown entity types; scalar counters still lose increments |
| Private immutable actions with compatible projections | Explicit deduplication, causal history, atomic multi-entity completion | Requires additive server endpoint and protected local ledger |

Choose the third option. Keep existing entity names and protocol-3 receipts.
Add a separately versioned action protocol, private ledger and canonical state.
Do not convert tasks, notes or plans into a general CRDT. New clients render
protected focus/counter state and the compatible projections published from it.
Unknown tracking and focus fields survive transformations. Invalid optional focus
data stays in the original envelope with a recoverable validation error.

## Identity and time

An action has an immutable UUID, authenticated account scope, actor ID, kind,
target task/session, expected parent revision, session epoch, and captured wall
instant. A start creates a new session UUID and epoch. Transport mutation IDs,
local commit generation and global server cursor are distinct from action IDs.
The server authenticates account scope; client history cannot supply authority.
Retries reuse the exact action and ID. Conflicting payloads under one ID fail.

New action timestamps use UTC milliseconds (`YYYY-MM-DDTHH:mm:ss.SSSZ`). Legacy
attempts retain their original precision, timezone spelling and fingerprints.
Java nanoseconds and PostgreSQL microseconds are not silently rewritten in an
old request. Causality uses revision/parent IDs, not timestamp comparison.
Elapsed time uses real action anchors and accumulated seconds; ticks do not
write. Backward clock changes clamp negative measured intervals to zero and
re-anchor on the captured clock while retaining the previous anchor in audit.
Logical revision timestamps must never become real elapsed-time anchors.

## Counter contract

For account/day/type, count = established baseline + distinct accepted deltas.
Each delta records action ID, actor, explicit local calendar day, IANA timezone,
counter type, signed integer delta and optional parent business-action ID.
Undo/correction is another identified event. No identity garbage collection is
authorized until a replacement checkpoint/tombstone scheme proves replay safety.

Current product evidence uses the device-local day (`getTodayYYYYMMDD`, native
local-date tracking initialization); there is no established account timezone
for these two counters. Retain that policy: attribute the day and zone once at
intent capture. Aggregate by the captured day, with timezone retained as context.
Changing zones does not reassign old events or reset an existing day's baseline.
Day rollover selects another day projection without mutating focus.

Legacy migration is evidence-based, never delta inference from snapshot equality.
The 27/F0, 28/F0, 27/F1 fixture has a provable stored count of 27 and a preserved
claim of 28. Two apparent 27→28 WAL entries do not prove one or two actions.
Retain alternatives, evidence IDs and current projection in a durable ambiguity.
Only authoritative evidence that proves a missing action permits a deterministic
audit-linked correction. Never relabel an old accepted or rejected receipt.
Cutover baseline references identify the historical evidence already included,
so importing the same receipt cannot count it again.

## Focus commands

Local admission must read, validate, transform, persist and enqueue under one
coordinator transaction. UI/ViewModel captures target identity and intention;
it must not later save a precomputed projection. Serial commands read their
actual parent. `extend` preserves phase; `extendAndResume` explicitly resumes.
Web's paused add-time control maps to the latter. Android's current add-time
control maps to `extend`. Passive hydration never creates a resume action.
Mac overtime remains active until an explicit stop or completion.

Unique extensions may add against an ancestor of the same still-open session;
state-changing commands require the expected revision and target identity.
Incompatible commands produce a durable rejected action with canonical state
for recovery, not a clock-based overwrite. Terminal identities remain terminal
even after a new session becomes current. A stale F command cannot act on G.
Range overflow must report a recoverable error; silently clamping an extension
would violate the admitted delta. Task planned-duration edits are distinct from
extending the already-running session.

Completion carries final notes, task transition and statistics/event effects as
one logical action. Locally all effects and enqueue must commit together or via
an idempotent recoverable transaction. On the server the action transaction
publishes all affected entities and one exact action receipt. Duplicate taps
cannot award twice. Notes must be durable before terminal UI success.

## Server and transport boundary

Read-only staging inspection is retained in `s2-live-definitions.json`. Applied
migration timestamps differ from source filenames; compare definitions/history,
not filenames alone. The global transaction advisory lock in
`goalflow_next_change_version` protects commit/publication ordering and must
remain. The inspected explicit push locked conflict before entity; reconciliation
locked entity before conflict. Isolated PostgreSQL reproduced 40P01; the forward
lock-order migration now acquires entity before conflict. Real committed-cursor
and rollback regressions pass. Future action writers must use the same order;
retries are limited to genuine serialization/deadlock failures with the same ID.

Legacy accepted receipts remain exact submitted-payload proofs. Action receipt
schema v2 must bind the exact operation, outcome and canonical projection
revision. Rejected actions and original reconciliation evidence remain durable.
Private tables need explicit grants/RLS and account isolation. Add only forward
migrations; no live DDL or deployment is authorized.

The existing JSON body budget is 262144 UTF-8 bytes, maximum 50 mutations. HTTP
headers are not counted by Express's JSON-body limit. Web now selects an ordered
prefix using the exact serialized wire fields, delimiters, escaping and UTF-8
bytes before marking attempts. A single oversized legacy request remains intact
and blocked without futile requests. All three clients now use byte-bounded batches. Explicit resumable recovery
and pre-admission validation remain implementation work.

Unbounded historical evidence must use authenticated staged chunks with a full
manifest, per-chunk hash verification and deterministic final operation ID.
Only complete verified manifests can reconcile. Never slice the last 1000 entries.
Conflict pages require a stable cursor and must preserve local unresolved history.

## Mixed-version boundary and rollout

A DB version bump is insufficient: old web code opens the newest IndexedDB
version and adds missing stores. Put authoritative new state in a dedicated
store outside legacy store lists; retain legacy captured intents separately.
New readers must detect incompatible legacy projection writes, preserve their
evidence and restore only from the protected authority. Prove this using actual
old code, including restart, backup/import and metadata writers. A banner or
server header alone is not a local write fence.

Ship dormant additive server support first only after separate authorization,
then capable clients with explicit epoch/capability negotiation and cutover
receipts. Old clients receive known compatible entity projections, never private
ledger entities. Protected fields from old writes must be preserved as audit
conflicts; they cannot replace established causal state. Activation is gated on
all three client implementations, real PostgreSQL fixtures, receipt tests,
old-tab evidence and an explicit rollout handover. No S3 permission yet.

## Causal HTTP boundary

`POST /sync/actions` accepts one schema-2 focus, counter or counterDay envelope under the existing authenticated API and JSON byte limit. Command objects are validated without normalization; their unknown keys participate in exact receipt identity. The receipt binds the original operation, account epoch, canonical projection revision, outcome and tracking record. Legacy mutation receipts are never reinterpreted. SQL rejects missing/stale enrollment epochs. There is no automatic cutover or capability-ready claim. HTTP 409 requires preserved-action recovery review; 503 transaction failures reuse the exact action ID and contents. No caller may infer acceptance or retire evidence from either failure response.

### Saved Web action transport

The client validates version-2 receipts using the same pure boundary as the API. One request transmits the saved JSON body unchanged, with a 256 KiB UTF-8 body limit and an 8 MiB receipt limit. HTTP errors never acknowledge an action. A valid receipt must still be committed with the journal by a separate durable application step; transport success alone cannot retire the outbox or advance a pull cursor. This transport remains dormant pending that integration and capability rollout.

### Durable Web receipt application

The private causal account row retains a wire request by logical action ID before transport. That request must exactly match an admitted command and is immutable across retry and account-epoch changes. Receipt archival and accepted-command retirement share one IndexedDB transaction; rejected receipts remain pending for explicit resolution. The original domain admission and wire/receipt evidence are never removed. Receipt records are historical snapshots, so this transaction does not apply their projection or advance the authoritative pull cursor. The pipeline returns an already archived receipt without a new HTTP request. Authenticated epoch enrollment and authoritative projection reconciliation are required before activation.

### Causal backup transport boundary

Causal account exports use schema 5 and retain an encoded private journal under `causal_actions`, including original wire bytes and receipts. The codec preserves undefined and own keys without treating user-shaped tags as metadata; unsupported structured-clone preimages fail visibly. This is preservation, not authentication or server acceptance. Ordinary accounts continue schema-4 exports. Legacy code must reject schema 5. Import and self-repair cannot fall through to legacy tracking writes on a fenced database; until causal ledger reconciliation exists they fail before replacement. A backup checksum is not evidence of server acceptance.

### Fresh-account causal restoration

The schema-5 importer now supports an empty destination account. It rechecks emptiness in the restoring write transaction, copies retained authority and raw sync metadata without normalization or new mutation IDs, and archives the exact imported artifact by checksum. Repeated imports return without replacing newer state. Restored legacy captures remain recovery evidence rather than executable WAL. Nonempty destinations still require an explicit journal reconciliation path; neither merge nor replace permits overwriting them. A validated local backup does not replace authenticated epoch discovery or authoritative server pull.

### Authenticated epoch discovery and immutable binding

`GET /api/v1/sync/causal-capability` is read-only, uses the authenticated immutable user UUID, and reports either no enrollment or the exact existing epoch/revision. Its private RPC is executable only by service_role and performs no writes. `rolloutReady` remains false. Local binding requires an already prepared causal store, never fences a database on discovery, and cannot replace an epoch or lower the observed revision. Existing attempted wire requests are checked before binding. Request preparation requires a matching bound epoch; it never rewrites old attempted bytes to adopt a new epoch. Capability revision is not a pull cursor and cannot apply a projection. Offline local admissions can remain pending while discovery is unavailable.

### Immutable causal history transport

Read history by authenticated account and immutable epoch, anchored to an observed causal `throughRevision`. Revision 0 is the original cutover receipt; subsequent revisions are retained action receipts. Every entry is delivered in 49,152-byte chunks with entry/chunk SHA-256, byte length and aligned offsets. Reassembly validates the entire receipt contract before any future durable progress may be recorded. New revisions do not change prior entry bodies. No count-based truncation or history identity retirement is permitted.

The API/shared implementation supports up to 16 MiB per entry, with 65,536-character maximum base64 chunk data. Larger retained entries produce an explicit unavailable/recovery boundary, not partial success. This checkpoint supplies authenticated transport only; it does not implement partial-download persistence, authoritative client projection application, enrollment or mixed-client activation. Ordinary pull cursors are unchanged.

### Durable causal history application

The private account journal owns download progress. Partial chunks retain their first horizon and exact verified offsets until the full entry passes byte/hash and receipt validation. The complete body replaces redundant partial chunks in the same transaction as revision progress; original receipt evidence is not retired. Each resumed/imported history is revalidated before use. A bounded call can return incomplete without dropping progress, and discovers later revisions only after finishing its saved horizon.

Projection application replays contiguous server receipts from the immutable cutover, checks counter conservation and focus outcomes, and verifies protected tracking against each receipt. Pending local commands are overlaid by original identity/parent; events already in server history count once. An accepted local outbox item retires only if the exact saved wire operation matches the receipt in the same transaction as projection/generation changes. Rejections retain pending evidence plus current and historical review codes. No ordinary pull cursor advances. Unknown local tracking fields and all unrelated collections remain intact. Mismatched legacy cutovers/baselines are explicit recovery boundaries. Application activation, native implementation and atomic server completion are still prerequisites for full S2 acceptance.

### Atomic completion receipt and note preservation

Completion is a distinct version-2 operation with the original `complete` focus command and one final task mutation plus the caller's required business-effect mutations. Up to six members cover tasks, stats, progress, goals, habits and task_events, at most one per type. These are existing entity types; no new type enters legacy entity feeds. Each member retains its exact original mutation contract. The outer action ledger binds the complete operation, outcome, canonical tracking revision and all member receipts. A member conflict or receipt mismatch aborts every write. Retrying the same action returns its immutable receipt; changing its body cannot reuse its ID, and a newly identified action cannot complete an already closed task again.

The server acquires sorted member mutation locks before entity locks, and keeps the existing publication lock behavior. Notes and supplied effects commit before terminal focus inside the same database transaction. SQL-generated history must fit the retained 16 MiB entry envelope or the entire action rolls back. Transport uses the existing 256 KiB direct / 4 MiB staged request limits. A future local completion coordinator must validate the combined envelope before reporting durable success and include every required business effect.

Canonical task notes are no longer truncated to 10,000 characters. Their forward constraint is now 4 MiB of UTF-8 text; unsupported larger values fail explicitly. Completion history can be retained and verified now, but applying it to client tasks, effects and focus requires one local transaction. The ordinary causal tracking applier deliberately refuses completion history until that integration exists. No rollout is enabled by this checkpoint.

## Web completion admission and dependency reservation

Web completion has a private logical outbox in the existing causal account authority. Stable action-derived UUIDs identify its task/effect mutations and event. The transaction derives effects from current collections and stores immutable affected preimages, rather than admitting a UI-computed snapshot. Statistics remain day-keyed; the capture supplies explicit day/timezone attribution. Existing Web reward semantics are retained, including frog, habit, goal, flow and completed-day bonuses; unknown progress fields survive.

Ordinary sync metadata reserves each pending completion member's local version. Earlier ordinary mutations remain sendable; later mutations depend on the reserved member and wait. The completion is not split into ordinary outbox entries. Its first wire serialization uses exact accepted predecessor versions, then remains immutable. Rejected server receipts and affected conflicts require explicit recovery. No mutation/receipt/history identity is garbage-collected.

Admission enforces both 3 MiB per member and the complete 4 MiB UTF-8 envelope, reserving maximum safe server-version digits. A failed final IndexedDB write rolls back business effects, terminal focus and journal together. Receipt commit archives all evidence and releases only exact matching reservations; it never applies historical snapshots or advances the ordinary pull cursor. Schema-5 export/restore retains and validates this dependency structure.

This coordinator is dormant. The history-only applier refuses pending or downloaded completion actions until atomic task/effect history application exists. Current-code reservations do not replace the required old-tab business-store fence. Activation must first provide the complete history/application path, native counterparts and preserved legacy recovery.

## Atomic completion history application

The Web history applier now replays versioned completion transitions and installs their task/effect records together with focus. The same transaction retains exact local acknowledgments and application preimages, updates per-entity versions, and advances local generation; it never advances the ordinary pull cursor. Each application refers to an immutable history revision/hash, and restore validates those references and bodies.

Incoming full server receipts do not require intermediate record snapshots when a replica has no pending local edit. Empty replicas can hydrate the supplied members; unversioned nonempty local records require recovery review. Locally admitted completions keep their already-derived effects and later edits. Only an original matching attempted request permits local receipt retirement; peer history alone does not invent attempted bytes.

Pending focus/completion commands replay in explicit parent order using original target identities. Completion preimages prove task eligibility for commands preceding a locally pending completion. Conflicting local completions or overlapping edits cause the entire projection transaction to abort; a separate durable review records the horizon and reason, retaining all original data and requests. Review history survives subsequent successful application.

This removes the former unconditional completion-history refusal. Active Web coordination, old-tab business-store fencing, native integration and explicit recovery remain prerequisites for mixed-version activation.


### Business authority beneath legacy store mirrors

Extend the existing tracking fence to all 14 other account stores, including sync. One IndexedDB versionchange copies exact values and cutover preimages to a compound-key private store before replacing legacy out-of-line-key stores with inline-key mirrors. Keeping private authority is necessary because legacy delete/clear accepts the same account key even when put is fenced. All causal coordinators include authority in their existing transaction and use shared accessors; authority and mirrors commit together. No migration is invoked automatically. Active ordinary writers, backup/restore and account lifecycle must use this boundary before cutover is enabled. Local captures remain separate retained evidence and require explicit recovery/admission. The supported-old-code fence does not protect against arbitrary code deleting the entire database. The native storage boundary remains separate.


### Authority-aware backups and ordinary storage

Schema-6 backups bind a complete business authority manifest to the account and retain exact current/cutover values separately from compatibility collections and old mirrors. Restore validates all binding and completion evidence first, writes an empty account atomically, and archives the original artifact. Repeated imports are idempotent without rewinding later work. Existing nonempty authority, even an absent marker, requires reconciliation. Schema-5 inputs remain supported without silently converting their saved requests.

Ordinary storage uses the same private authority in its existing IDB transactions. Its snapshot path cannot mutate causal day/counter/focus fields. New ordinary WAL captures are marked at creation only and their entity/payload consistency is checked before fenced admission. An older or incompatible captured group is preserved in full with a durable review, never partially applied or interpreted as a counter delta. Fallback copies remain separate evidence. Exact private retention and journal deduplication permit normal WAL retirement after commit. Completion waits for unresolved local capture reviews. This enables ordinary storage on a fenced database but does not itself activate causal UI commands, initialize new accounts behind the global fence, or order ordinary pull pages against completion history.

### Offline day selection and increments awaiting a baseline

A local `select` for an established day projects that day's baseline plus distinct events atomically with admission and its mirror. An unknown day retains the last provable date/counts and stores the requested day with `WAITING_BASELINE`. Focus and unprotected tracking fields remain unchanged. UI wiring must use this explicit status; it must not label yesterday's count as today's or apply threshold penalties from it.

A distinct counter increment may be captured after a durable day admission even when its baseline is unknown. It retains the same action/account/day/timezone identity through restart and retries, but cannot produce a first wire request until the baseline exists. No correction can use this missing-baseline path. Authenticated complete history installs the baseline, merges pending events once and then permits transport. Historical legacy claims can still require baseline recovery instead of zero; this does not erase the new offline intent.

Pending local day selections replay in local generation order after the newest represented local selection. Earlier unacknowledged selections cannot overlay a later represented selection; their original outbox evidence remains retained. The scheduler must send day selections in local order and preserve the explicit recovery path for restored ordering conflicts. The UI and scheduler are not activated by these primitives.

### Web focus controls at the private authority boundary

After an existing account is explicitly fenced, the rendered timer captures target session/task identity, action identity, timestamp and visible control meaning before awaiting storage. The control carries its observed session through the timer callbacks; a newer rendered-reference update cannot retarget an old click. The private transaction derives the target epoch and actual parent revision, checks task eligibility, applies the command and retains the original UI control inside the immutable admission and exact wire command. Retrying the same control uses its original derived command.

The visible add-time control means extend and make active. The transaction emits `extendAndResume` when its target is paused and `extend` when already active. Rapid paused add-time clicks therefore extend by both amounts without reusing a stale paused snapshot. The underlying explicit domain commands retain their distinct semantics. Ordinary legacy callbacks retain their existing path until the account fence exists.

Rendering consumes committed snapshots rather than applying an asynchronous handler's older returned projection. Causal outboxes contribute to pending status so ordinary sync cannot falsely report complete convergence. An explicit day boundary uses the day journal on a fenced account and retains its pending request across hydration. This wires focus controls only; completion, counter business effects, enrollment and causal network scheduling still require integration before activation is ready.

### Rendered focus completion and retry

The checkout dialog retains its original task, observed focus identity and final notes. Its first completion attempt fixes duration, action identity and day/timezone attribution; retrying the same details reuses that capture. The local completion coordinator resolves the target epoch inside its transaction, retains the original UI control, and applies terminal focus together with task notes/status and effects. No old epoch or UI snapshot is saved as a new parent.

The full UI callback chain awaits durable admission before closing checkout, offering a break, sounding success or celebrating. A failed write leaves checkout and its original notes available; a second click cannot enqueue a concurrent duplicate while the first call is pending. Rendering remains owned by committed storage subscriptions. Non-focus task completion retains the existing ordinary path; its cross-client concurrency boundary remains part of the outstanding integration review rather than being claimed as causal completion evidence.

### Web reschedule business admission

Fenced Web rescheduling captures the account, actor, task, requested exact date, action UUID and day/timezone once. Inside one IndexedDB transaction it reads the current task, checks availability and the existing frog commitment, derives forward movement and the reschedule count, and captures an ordinary task mutation. Moving a task from the captured current day to a later date also admits one deterministic child counter event with the reschedule UUID as `businessActionId`. Task authority/mirror, ordinary queue/journal, counter authority/mirror and immutable admission commit or abort together. Different moves read their actual preceding task; retrying the original action returns its retained outcome. Notes, unknown fields and focus remain unchanged.

The task keeps the existing ordinary transport/receipt contract. A counter denotes a locally admitted postponement action; no already attempted task or counter request is rewritten. This checkpoint proves local atomic admission, not cross-entity server atomicity or finished causal scheduling. Unknown-day counters remain retained until a verified baseline is available. Backup and recovery must retain the `rescheduleAdmissions` evidence along with its task transaction and counter; comprehensive recovery validation remains part of the unfinished S2 acceptance work.

The rendered reschedule dialog awaits durable success, blocks simultaneous submissions, and stays open after a failed write. Matching failed attempts reuse the original capture. A returned durable rejection ends that capture, so a later deliberate choice can be admitted against changed task state. Planning visits and their penalty effects still require their own counter business admission; this change does not activate account cutover.

### Web planning-visit admission and deferred effects

A planning visit is an immutable business action with a deterministic child `planViewCount` event. Its private local admission records the current penalty setting, local admission sequence and IDs of the counter events observed for that day, including itself. Counter admission, a known-baseline penalty, progress, ordinary progress mutation/journal and the effect marker share one IndexedDB transaction. Concurrent visits read their actual predecessor; equal timestamps do not collapse them. Failed matching UI attempts retain the original intent, and navigation waits for durable admission.

The existing rule is preserved: the observed sixth visit warns; later observed visits use off/gentle/classic penalties (0/25/50 XP), floored at zero XP. This is the UI's observed-count rule, not a new policy ordered by later server acceptance. The captured event frontier ensures that later-arriving remote events or later local visits do not retroactively change an earlier warning into a penalty. The canonical account/day count still includes every distinct applicable event.

When a baseline is unknown, the visit and its frontier remain durable with `WAITING_BASELINE`; yesterday's displayed count is never used. Downloaded causal history supplies the verified baseline and settles pending effects, in local admission order, in the same transaction as history application and the progress mutation. A failed history write rolls back both the penalty and its marker. Settings changes after capture do not reinterpret the original mode. Retries never apply an `APPLIED` effect again. The private frontier and transaction evidence must remain in backups; no history pruning is introduced.

The rendered warning states six visits and reflects whether penalties are enabled. This integration leaves the existing ordinary progress receipt contract intact and does not activate rollout. Native command integration, network scheduling/enrollment, non-focus completion concurrency and full recovery/mixed-version acceptance remain open S2 work.

### Account initialization after the database-wide fence

`initializeIfAbsent` can create tracking for a UUID account with no causal record, tracking mirror or retained local tracking copy. This path accepts only new local defaults (zero counters and no focus), copies the input before yielding, and atomically adds authority, its mirror and one explicit day-selection admission. `localInitialization` retains those defaults; `cutover.trackingPresent` remains false to preserve the actual prior absence. The day is `WAITING_BASELINE`, with no invented server counter baseline. New local planning/focus intents can then be admitted while server discovery remains pending.

Recorded absence, an undefined authoritative value, an orphan mirror, retained fallback/recovery data, nonzero defaults and legacy imports remain recovery cases. The initializer does not overwrite them. Legacy email-to-UUID lookup is a no-op only when source authority, mirrors, snapshots, captured evidence and known legacy keys are all absent. Actual identity rebinding remains refused, and fenced legacy imports cannot bypass that boundary through the generic initializer. The empty lookup is needed for ordinary UUID account hydration, since the App still checks its legacy email key.

This is local account preparation, not server enrollment. Enrollment/history reconciliation must explicitly reconcile the preserved initial absence with verified server cutover evidence; it must not relabel defaults as an established cloud baseline. No cutover flag or live configuration is enabled by this change.


### Server enrollment from preserved local absence

A fresh local account may send a distinct version-2 initialization request containing its account UUID, stable initialization UUID and immutable zero-count/no-focus defaults. The service-only initialization transaction uses the existing tracking entity lock. It selects existing tracking unchanged; when the row is absent, any retained legacy tracking or unscoped mutation/conflict evidence blocks creation. Otherwise it inserts the defaults using the existing committed publication-order function, then invokes the original exact compare-and-establish cutover in the same transaction. A tombstone never becomes a fresh zero baseline.

The initialization UUID becomes the epoch. Private account columns retain the exact initialization request and outer receipt, including whether creation occurred and the unchanged nested cutover receipt. Identical retries return the original receipt even after later actions. Different requests cannot replace it. The authenticated HTTP route binds the immutable user UUID and shares the 4 MiB staged transport; no new entity type enters the old feed.

On the client, request and receipt storage never rewrites local absence, defaults, pending commands or cursors. Verified revision-zero history explicitly binds fresh local initialization to server history before projection. A lost response retries the same initialization UUID; if a different epoch won, the original attempted request remains retained without being relabelled as accepted, and verified winning history supplies the baseline. The local day selection and distinct increments then follow the ordinary causal action protocol. Existing nonempty local evidence continues to use exact known-version cutover or explicit legacy recovery.


## Native Room counter/day admission

The private Android journal now records counter and day admissions with a shared monotonically increasing local sequence. Action IDs cannot be reused across focus, counter or day kinds. Each ordinary increment has immutable account, actor, day, zone, type, delta and captured timestamp; corrections and business-linked events require their dedicated coordinator. The current local cutover counts remain preserved evidence, not an asserted server baseline. Local projected counts equal those preserved counts plus distinct matching-day admissions.

A day selection for an unknown baseline retains the last provable tracking date/counts and a WAITING_BASELINE selection. Subsequent events for that admitted day are retained without changing the previous day or focus. Verified server history is required before projecting the unknown day. Native enrollment/history/receipt retirement and UI integration remain outstanding. No protocol activation or migration is introduced by this checkpoint.


## Native history evidence boundary

Android now retains bounded history chunks and exact complete bodies in the private account journal. A downloaded revision is transport evidence only: no projection or outbox is changed by download. Restore revalidates every consecutive revision, checksum and receipt, including the complete member receipt contract for atomic completion. Partial chunks retain their original epoch and through-revision until the entry completes. A future replay transaction must bind cutover to local evidence, replay authoritative history, overlay unrepresented local admissions and retire only exact represented receipts atomically. This checkpoint does not enable that unfinished integration.


## Native enrollment and evidence orchestration

Android now has an explicit evidence sync entrypoint using the production session-bound HTTP method. Enrollment requests are persisted before sending and retries reuse the same bytes and identity. A known tracking cutover requires exactly one preserved positive server version; missing or conflicting evidence remains a recovery case. Fresh local defaults may initialize an absent server record or receive proof of an existing legacy baseline without relabeling local pending increments as baseline counts. Downloaded history remains separate from projection application. Normal UI activation and atomic acknowledgment await the remaining native integration.


## Retained native admission bases

Local admissions must remain verifiable against the server revision visible when they were captured. Native replay can reconstruct that earlier prefix after history grows, without slicing or rewriting stored evidence. A requested revision must already be downloaded; all retained envelope checksums and receipt structures are still validated. The upcoming admission timeline must record projection transitions between local commands and preserve original outcomes rather than replacing them with later server outcomes.


## Native applied-history timeline and receipt boundary

Each applied history basis has a local sequence, immutable account epoch, server revision and captured eligibility evidence for pending focus tasks. These entries share the local generation sequence with admissions. Validation replays the original cutover, each original command/outcome and intervening verified history prefixes, then compares protected projections. A newer server result changes the pending overlay and review, never the original admission outcome. Historical task eligibility remains reconstructible from the recorded projection event.

Ordinary counter events are unioned by exact action identity over verified day baselines. An unestablished day remains retained with BASELINE_REQUIRED; a pending selection cannot relabel another day's counts. Request preparation requires an applied account baseline, and counter preparation additionally requires its verified day baseline. Exact receipt proof and matching applied history jointly authorize outbox retirement. Merely downloading or receiving a receipt never advances the ordinary sync cursor. All accepted completion member application remains gated until its native business transaction is implemented.


## Native bounded authenticated action pass

The native action pass uses the production session-bound request method and existing mutex. Eligible commands follow local admission sequence; counters require an applied day baseline, and task reviews or retained rejected receipts are not sent repeatedly. The pass never mints a replacement action. Each response is retained before another verified history application authorizes retirement. Lost accepted responses can be recovered from exact history without retransmission. The 50-action pass bound limits one invocation, not retained history or queue size; `moreReady` refers only to eligible unsent work and must not be presented as proof that review queues are empty. Normal activation still awaits native completion integration.


## Native completion member application

Accepted completion history is no longer categorically blocked on Android. Member payloads, their per-entity metadata, protected tracking and the observed causal basis commit in one Room transaction. A member with newer server evidence is retained as represented; equal-version replicas without pending edits must match the native typed projection. Older replicas require no pending edit/conflict and a known server baseline, except absent records or explicit empty defaults. Application never treats a member server version as an ordinary pull cursor.

Exact history bodies remain the receipt authority. Existing native codecs define typed replica comparison; this does not rewrite the receipt. Applications preserve member preimages and decisions, tied to the local projection sequence and history hash. A member needing review rolls back every prior member write, then retains only a history-bound recovery reference. Local causal completion admission and its member reservation/transport protocol still require implementation.

### Native ordinary predecessor evidence

Causal-enabled Android accounts retain each exact queued predecessor request and complete parsed accepted receipt in `legacyPushReceipts` atomically with ordinary outbox retirement. Validation binds immutable account and request identity, payload, device, versions and timestamps; the first retained proof is immutable. Completion reservation code can later resolve dependencies from this evidence rather than infer acceptance from the current entity version or cursor. This checkpoint does not yet activate native completion admission.
