# Independent S1 implementation review

Status: **BLOCKED** for full S1 acceptance. Reviewed 2026-09-07.

Reviewed local and fetched remote branch `codex/s1-local-durability-20260907` at `8a7000d040a68cba4ce352e821430fbf1e70370a`; production implementation is `9f5457919d015d895d057e592ae7c5685f6a4d9c`. Fetched staging remains `6f750a712f253754bfac840d8edc5d846b360b7d`. Original handover and draft-fix reference commits are ancestors. Checkout was clean before review. No implementation changes, deployment, installation or owner-data writes were made.

## Findings

1. **S1-R1 / P1: fallback reads still shadow acknowledged records.** `services/storage.ts:962` returns fallback bytes before consulting healthy IndexedDB. A deterministic synthetic fixture installs a remote task and cursor atomically, then supplies an older fallback copy (representing a retained or peer-written fallback). `get(tasks)` returns the old title instead of the acknowledged title. Recovery may subsequently block on the differing histories, but that does not make this read authoritative. Requirement F explicitly prohibits this shadowing. Preserve ambiguous fallback evidence separately and read verified committed records, or return a structured blocked result.
2. **S1-R2 / P2: explicit local set silently drops its argument when any store has WAL.** `services/storage.ts:980` substitutes an account drain for the requested write. The fixture captures a task, then awaits `set(amalgam, user, 'independent note')`; the promise resolves but the note is absent. This exported API remains an independent admission path and contradicts the requested all-caller/multiple-store contract. Current React effects have correctly stopped using it; no current UI note-loss incident is inferred from this API reproduction. Either capture the explicit action safely or reject unsupported use; a successful no-op is unsafe.

Both failing assertions are retained in `s1-review-regression.test.ts`. Production source is unchanged. These are acceptance failures, not repaired findings.

## Fresh verification

- `npm run verify:release`: exit 0, 68 files / 405 tests, builds and server/maintenance/artifact checks passed. Run collected the existing suite before adding the review fixtures. An initial sandbox invocation failed due to loopback EPERM; the authorized rerun passed.
- `npm run test:s1:storage`: exit 0, 15 tests.
- `npx vitest run docs/operations/reliability/connection-regression.test.ts`: exit 0, 2 tests.
- `npm run test:s1:browser -- --repeat-each=3`: exit 0, 30 executions across Chromium/WebKit.
- `npx vitest run docs/operations/reliability/s1-review-regression.test.ts`: exit 1, both newly added assertions fail. The full suite will also collect these failing review fixtures on its next run.

Logs: `evidence/S1_review-release.log`, `evidence/S1_review-browser.log`, `evidence/S1_review-regressions.log`. Node v22.16.0, npm 10.9.2. Tests use synthetic storage/browser profiles. The passing existing suites do not override the two counterexamples. No new hosted CI, installed build, or deployed service-worker identity was verified. This review does not certify exhaustive coverage of every schedule in the supplied specification.

## Handover

Reopen S1 for the two reproduced defects before accepting its full PASS_LOCAL claim. Existing atomic metadata ownership, deferred-drain and two-tab improvements have passing local evidence. Preserve those changes. No migrations or durable identifier changes were made in this review. Cross-device counter conservation and historical ambiguity remain gated by S2; hosted/native and release obligations remain separate. Production remains NOT READY.
