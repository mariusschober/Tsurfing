# S1 local synchronization invariants

Scope: browser-local ownership, durability and visibility. Cross-device counter conservation remains S2. No deployment or production release is implied.

| State | Durable authority | Transition and visibility |
| --- | --- | --- |
| Editable draft | Component text plus task/base identity | Capture failure keeps input; hydration is not an action |
| Captured intent | Account-scoped read-verified WAL; exact envelope for a group | Capture precedes optimistic acknowledgment; capture is not projection commit |
| Committed projection and pending operation | One IndexedDB transaction over data plus latest sync metadata | Group prevalidation; journal and projection/outbox commit together; incompatible new groups are preserved wholly as blocked evidence |
| Attempted immutable request | Latest outbox read and attempted marker in one transaction | Network begins after transaction completion; no network-length local lock |
| Receipt or conflict | Strict existing receipt validation, retained exact request/result, conflict history | Accepted acknowledgment retires outbox; conflict transfer preserves mutation identities |
| Reconciliation | Latest WAL and metadata, exact candidate reply, archived resolved conflict | A changed candidate cannot erase a newer action; response evidence remains local |
| Local generation | Monotonic local metadata updated with commit | Account/database/build-context invalidation follows transaction completion |
| Rendered generation | Coherent snapshot with validated pending overlay | Refs and state update together; React acknowledges rendering separately |
| Fallback recovery | Committed IDB projection plus exact fallback-copy receipts | Source bytes remain intact; unmatched copies block certification and never shadow canonical data |

## Happens-before proofs

1. **Metadata:** every writer reads current metadata inside its readwrite transaction. A peer transaction sharing sync either commits before that read or runs afterward. Preparation, receipt, success, conflict merge, manual resolution, raw metadata import, fallback recovery and seeding all follow this boundary. Metadata alone cannot advance the cursor.
2. **Inbound and reconciliation:** WAL observed before materialization participates in the same transaction as inbound records and cursor. Later admission stays in WAL and is checked against the resulting projection on the next drain. Exact original payloads are never rewritten. A stale new focus action is classified as `STALE_FOCUS_INTENT`; a stale new group as `STALE_GROUP_INTENT`.
3. **Groups and restart:** candidate values and metadata are computed for the complete envelope before any member is installed. Any incompatible new member blocks the whole group, retaining the raw envelope and every original transaction. A legacy incompatible group aborts and retains its WAL bytes. An aborted IDB transaction installs neither records nor cursor. WAL retirement requires equal journal evidence; leftover accepted WAL cannot create another operation.
4. **Fallback:** get() reads IDB plus relevant metadata before applying permitted WAL. A mirror cannot override a record or resurrect a versioned deletion. Recovery reads current metadata and installs compatible records and an exact-copy receipt in one transaction. Source keys are not deleted: localStorage lacks atomic compare-and-delete, so retaining them avoids deleting a concurrent peer replacement. A known copy is not recovered twice; an unknown copy remains pending. An unverifiable advanced fallback cursor blocks recovery.
5. **Explicit writes and snapshots:** set(local) materializes earlier captured work, reads the latest target and admits its supplied action. It never substitutes a drain for that request. React effects call only the account drain. Raw set(cloud) is test-build-only. Initial seeding and day rollover read the latest projection inside IDB; versioned normalization and legacy-plan initialization cannot resurrect stale collections from deferred hydration.
6. **Visibility:** completion messages are hints, not proof. The same-origin storage fallback, focus/resume and visible-page periodic checks reread committed state even when another tab consumed the shared cursor. WAL reads inspect content rather than key count or age. Incompatible grouped overlays are not partially rendered. Dirty note drafts remain separate.
7. **Lifecycle and status:** async state validation is revision-checked; disposed account effects cannot apply later reads. A success label requires no unresolved WAL/fallback, outbox, conflict or blocked intent and a hydrated committed generation. Peer hints do not clear the cloud permanent-error latch. Local retry verifies atomic storage and drains without requiring a cloud client; a local recovery message cannot replace a newer cloud error.
8. **No silent normalization:** day rollover validates date, counters and focus before creating an audited reset. Required malformed data is rejected rather than converted to zero. Optional nulls and unknown fields remain preserved.

## Compatibility and remaining boundaries

Database names, account keys, WAL prefix, native bundle/secure-store/URL identities, IndexedDB schema version, SQL migrations and Room schemas are unchanged. Additive localState fields retain groups, recovered fallback copies, resolved conflicts and reconciliation replies; backups preserve them. New group envelopes add admissionVersion=1; older envelopes retain their exact content and fail closed on ambiguity.

The test harness is imported only under MODE === test and checks that mode itself. Production artifact verification rejects every __s1 marker. No test-control endpoint is shipped.

Automatic database replacement remains blocked without an admission fence. Older running binaries cannot be retroactively repaired. Hosted/native rollout, recovery activation, signing and release gates remain separate; cross-device scalar ambiguity must not be repaired by max/sum in S1.
