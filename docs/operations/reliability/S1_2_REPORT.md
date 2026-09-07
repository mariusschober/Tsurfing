# S1.2 review and correction

S1 prerequisite: tested implementation `09245261b6174ec878f0296ca61682c603f54304`, integrated via documentation checkpoint `85f1c68e46c2577bb56d3cf5dbebb51fdb40673d`. All branches/tags fetched; both original handover and S1 implementation are ancestors of the current branch. The original S1 evidence and two review regressions remain unchanged. Historical Goalflow directory is absent; the dirty temporary focus experiment was inspected but not modified.

Reviewed the original S1 plan, report, ownership matrix, committed-state/WAL/fallback boundaries, grouped materialization, account lifecycle and status recovery. Counter snapshots, wall-clock focus causality and native completion atomicity remain S2 scope and are not inferred from S1 tests.

**S1.2-R1 — corrected:** a cloud error followed by a local failure and successful local recovery hid the unresolved cloud error. The two browser engines reproduced this sequence at the S1 baseline. The status component now remembers the independent cloud error until a cloud state transition supersedes it; local recovery restores it rather than certifying cloud health. Local-only recovery still works. No storage, wire, identifier, migration or product behavior changes.

Implementation: `262fa6e96a8cba7d0ebbb6843b9f8a0131b4cb7d`. Exact-commit release verification and repeated browser results are recorded in `S1_2_HANDOVER.json`. Baseline failures remain in `evidence/s1_2-status-baseline.log`; corrected and final outputs are retained separately. This report is a subsequent documentation-only checkpoint.

S2 must address the independently observed remaining design limits: scalar tracking snapshots cannot prove distinct increments; focus transitions still use timestamps as revision evidence; native UI reads precede transactional writes; native completion uses separate focus/task writes; queued batches are count-limited, and reconciliation/conflict transport is bounded without paging. S2 requires explicit operation identity, causal/terminal history, immutable legacy evidence, atomic completion, byte-aware transport and a mixed-version local authority boundary. No source changes for these were made during S1.2.

No deployment, native installation, live configuration change or owner-data test was performed. Hosted release remains BLOCKED/NOT READY. The permitted next stage is S2 on this integration branch.
