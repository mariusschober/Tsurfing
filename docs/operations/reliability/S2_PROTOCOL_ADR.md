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
