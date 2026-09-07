# S1 requirement and ownership matrix

Correction baseline: `8a7000d040a68cba4ce352e821430fbf1e70370a`. Review evidence checkpoint: `9c0710489393746645ca3ad98fe0d70a45dad4bf`. Exact final command results are recorded in S1_HANDOVER.json; this matrix maps requirements to assertions, not to deployment claims.

| Requirement | Production ownership | Acceptance evidence | Disposition |
| --- | --- | --- | --- |
| A: stale peer and shared cursor | committed snapshots, account subscription, coherent hook refs | S1 browser paused/completed peer cases run the actual synchronization cycle with an empty synthetic pull at cursor 100, then inspect the next captured baseline | Local test required; no hosted inference |
| B: metadata lost update | updateSyncMeta + readwrite transaction; records join transaction where dependent | storage.s1 writer barriers cover preparation, nonempty exact receipt, nonempty server conflict, both manual resolutions, success, metadata import, fallback and initial seeding; browser repeats native IDB writer barriers | Independent B record/outbox survives reopening |
| C: obsolete React persistence | account drain scheduler; no delayed set(snapshot) | browser obsolete callback, account-switch/unmount; hook source contract; timer ticking assertions | Zero manufactured actions |
| D: inbound and reconciliation admission | materializeWal within all-store transaction | before/during/after tests in fake IDB and real browser IDB; exact journal and outbox/conflict checks; invalid inbound abort | WAL-only and committed intent retained |
| E: grouped actions / notes | capture envelope, group prevalidation, atomic projection/journal/outbox | grouped stats/task rollback, blocked group plus independent note, legacy group preservation; browser actual completion plus second note under fixed clock <300ms | No partial new-group materialization |
| F: fallback | committed reads; exact fallback-copy receipts in IDB | acknowledged tombstone, stale fallback, conflicting/identical copies, concurrent replacement, unavailable IDB and mirror faults | Fallback cannot shadow canonical data or advance cursor |
| G: equal-count cache | current WAL scan and journal deduplication | storage equal-count test; two-page equal-count replacement; repeated drains; no idle cache code | Content replaces length/time heuristic |
| R1 review counterexample | get + shared pending overlay | original review assertion retained; independent records + retired WAL coverage | Must pass unchanged |
| R2 review counterexample | explicit set separate from drain | original note assertion retained; same-store/identical write/restart/abort cases | Must pass unchanged |
| Bootstrap | initializeIfAbsent, versioned collection migration, transactional day rollover, atomic cloud seed | concurrent initialization/migration/day tests; two real tabs import/reload one legacy plan; existing account migration/backup tests | No stale bootstrap snapshot writer |
| Status | lifecycle/revision-checked async reads, rendered generation, account scope | browser newer error vs old read, wrong account, missed hints, no BroadcastChannel, note quota failure | Peer hints do not clear error or certify this view |
| Product/auth preservation | existing domain scheduling and authenticated fetch boundaries | scheduling tests preserve confirmation after add/complete/reorder and overdue gates; auth/session/cross-user tests remain in release suite | No product, credential, or durable-ID change |
| Compatibility | additive localState groups, fallbackCopies, resolvedConflicts, reconciliations | legacy WAL exact bytes, null/unknown fields, backup/restore, connection replacement | Wire, SQL, Room, DB version unchanged |

## Metadata writer audit

| Entry point | Transaction / durable effect |
| --- | --- |
| updateSyncMeta: preparation, push receipt, success, server conflict, local resolution, metadata import | latest sync read and write in one readwrite transaction; removed conflicts archived; metadata-only cursor advance rejected |
| set(local) | materializes existing WAL, reads latest target, captures explicit request, commits projection/journal/outbox; no drain-as-success shortcut |
| set(cloud) | raw fixture seeding is test-build-only; production must use inbound APIs |
| flushPendingLocalChanges | fallback ownership recovery followed by all-store materialization; exact journal before WAL retirement |
| applyRemotePage | all data stores + sync; WAL materializes before remote transition; cursor rollback on any failure |
| commitAutomaticReconciliation | all data stores + sync; validate exact candidate reply; archive resolved conflict and retain reply; changed candidates stay unresolved |
| resolveConflictWithCloud | all stores + sync; expected conflict validation; even an already-resolved ID commits unrelated materialized WAL with its journal |
| recoverFallbackState | latest sync + affected records; incompatible/tombstoned history blocks; exact source-copy receipt and projection commit together; source keys retained because localStorage lacks atomic compare-and-delete |
| initializeIfAbsent / migrateCollectionV1 / rolloverTrackingDay / seedUnsynchronizedLocalData | all stores + sync; latest projection and ownership decide the action; migrations and original actions retained |
| migrateUserKey / migrateFromLocalStorage | delegates absent initialization to transactional API; retains source data and existing target |
| importBackup | hash/owner validation outside IDB; all-store transaction materializes current WAL, merges preserved metadata, journals restore intent, installs records |
| snapshot/createLocalSnapshot | readonly export then separate snapshot store write; no replacement of sync metadata |
| delete/clear | sync deletion and shared-store clearing refused; account record deletion uses explicit local set; fixture destruction uses synthetic raw IDB only |

All live transactions await only IDB requests. Network calls and backup hashing remain outside transactions. Module-level queuing is scheduling convenience, not the cross-tab correctness boundary.

## Explicit test-contract changes

Two pre-S1 fixture calls passed captured render snapshots to set(); their data/outbox assertions remain, but they now call flushPendingLocalChanges, matching the production drain contract. Fallback recovery's former source-key-deletion assertions are superseded by exact-copy receipt assertions while retaining the original bytes: deleting a mutable localStorage key cannot be made safe against a non-cooperating peer. The original review assertions are unchanged.

## External boundaries

S1 CI is enabled for the exact branch, including repeated browser/storage cases. Its hosted preflights intentionally fail closed before network/account activity: this candidate is undeployed and dedicated-account authorization is unverified for this run. Aggregate beta CI cannot be claimed green. Native CI artifacts, hosted behavior, signed releases, recovery activation and rollout remain separately reported gates. Cross-device counter conservation and historical scalar ambiguity remain S2.
