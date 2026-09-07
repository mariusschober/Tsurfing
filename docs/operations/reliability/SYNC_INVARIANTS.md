# S1 local synchronization invariants

Scope: browser-local ownership, durability and visibility. Cross-device counter conservation and wire reconciliation remain S2 work. This is not a release claim.

| State | Owner and durable evidence | Transition / visibility |
| --- | --- | --- |
| Editable draft | Component owns text and its task/base identity | Capture failure retains input; hydration cannot submit it |
| Captured intent | Account-scoped, read-verified localStorage WAL; one envelope per grouped action | Capture precedes optimistic UI acknowledgment; capture is not committed projection durability |
| Committed projection + pending operation | One IndexedDB readwrite transaction over participating data and latest sync metadata | Materialize group, retain exact original intent in `localState.journal`, append outbox or preserve a blocked admission, advance local generation, commit |
| Attempted immutable request | Latest outbox read and attempted marking in one IndexedDB transaction | Network occurs after transaction completion; no network-length local action lock |
| Accepted receipt / conflict | Existing strict receipt validator; exact accepted request/result retained in `localState.receipts`; conflict history retained | Outbox removal only follows validated exact acceptance or existing durable conflict transfer |
| Reconciliation | Re-read latest metadata and materialize WAL inside the inbound transaction | A stale reconciliation candidate cannot silently remove newer history; abort preserves the entire transaction |
| Committed local generation | Account metadata incremented with each successful commit | Publish payload-minimal account/database/build-context/store hints only after `tx.done` |
| Rendered generation | One readonly snapshot, permitted pending overlay, coherent React refs/state | Ignore obsolete generations; acknowledge visibility after React commits; resume and periodic reads recover missed hints |

## Happens-before arguments

1. **Metadata lost update (B).** A writer reads metadata in its own readwrite transaction. Any B transaction touching `sync` either completes before A's read or starts after A's commit. The old read-A / commit-B / overwrite-A gap no longer exists. This applies to preparation, receipt commit, success marking, server-conflict merge, local resolution, cloud resolution and metadata import.
2. **Inbound admission (D).** Inbound transactions include every local data store and `sync`. WAL already admitted is materialized, including its group, before the remote transition inspects pending state. A later admission remains in WAL. Its subsequent materialization checks the canonical baseline. An incompatible new focus transition becomes `STALE_FOCUS_INTENT` in durable blocked evidence; it cannot overwrite the newer session. Legacy ambiguous WAL remains unchanged and fails closed. Before/during/after schedules have separate assertions.
3. **Crash/replay.** Projection, outbox/conflict transfer and original intent journal commit together. WAL retirement occurs only after exact journal equality is durable. A leftover WAL after receipt acceptance cannot manufacture a new mutation. A failed transaction does not retire WAL or advance the cursor.
4. **Deferred snapshots (C/E).** React effects no longer call `set(store, capturedValue)`. Capture events request an account drain; a dirty flag forces another pass when admission occurs during a drain. Coalescing cannot pick only the last store. Raw hydration produces no local action. Two explicitly named migrations own former implicit bootstrap normalization.
5. **Peer visibility (A/G).** A peer completion is only a refresh hint. Tabs sharing one browser context reread shared IndexedDB even when the network cursor has already been consumed. Storage events, focus/resume and a five-second visible-page check cover absent BroadcastChannel and missed events. WAL reads inspect current contents; key count and age are not content revisions. No idle cache callbacks retain obsolete collections.
6. **Status.** A `Synced` event is account-checked and verified against WAL, outbox, conflicts, blocked intents and rendered generation. Asynchronous status validation is revision-checked. Peer messages cannot clear a permanent-error latch. Storage errors do not trigger reauthentication; HTTP 403 no longer causes generic session rejection.
7. **Fallback (F).** Inbound application and metadata advancement require IndexedDB atomicity. Optional mirrors are not commit evidence. An interrupted fallback cursor ahead of IndexedDB is refused, with both histories retained. Retry reopens atomic storage; no history is guessed or cleared.

## Compatibility and recovery

- Database names, object-store names, user keys, WAL prefix, bundle identifiers, native schemas, wire mutation format and PostgreSQL migrations are unchanged.
- Additive browser-only `sync.localState` carries generation, original intent journal, exact receipts, blocked intent reasons and migration markers. Backups preserve this evidence. Journal entries are not truncated.
- `web-task-defaults-v1` and `web-progress-threshold-v1` read current data inside the transaction, retain unknown fields and produce audited actions only if values change. Missing optional fields are distinct from explicit null values.
- Unsupported or malformed committed singleton projections block visibility certification rather than silently becoming defaults. An incompatible legacy scalar WAL remains recoverable but unresolved; S1 does not sum or maximize historical counters.
- Automatic shadow-database activation is deliberately blocked: a localStorage pointer flip cannot atomically fence concurrent tabs. The old database and verified recovery copy remain intact. Record APIs cannot clear a shared store or delete sync evidence; synthetic destruction fixtures use their own raw IndexedDB writes.
- Older running binaries cannot be retroactively repaired. Mixed-build invalidation hints are rejected; authoritative resume reads remain necessary. All active web clients must load the repaired build before deployment acceptance. Native/hosted rollout and recovery UX remain later-stage obligations.
