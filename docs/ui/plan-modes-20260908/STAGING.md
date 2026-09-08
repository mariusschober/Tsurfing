# Plan modes and density — 2026-09-08

Based on staging `6819e7ef430a384d27b8606e94c6caaf504416ac`.

## Behavior

Plan has independent Manual / Prioritize / Circadian controls. Manual preserves the current order. Prioritize opens the existing task-rating quiz without requiring a bio check-in; completing it uses the existing ranking handler once. Moving a task manually returns the selector to Manual. Mode survives same-day navigation and resets to Manual on the next local day; an open quiz closes at that boundary. Escape cancels with focus restored; the Plan quizzes contain keyboard focus and the rating grid supports arrows and Enter.

Circadian opens the existing check-in and retains its guidance. It does not introduce circadian ordering; that remains deferred. Switching Plan to Manual retains the check-in and the Current page's existing behavior.

Compact is the default, with content-driven rows (72px minimum, 12px gaps). Proportional retains the previous duration-based heights. Layout preference is per account in browser storage; density changes do not change task data. The duplicated populated-list Add controls are removed; the floating Add button and contextual empty-state Add remain. The confirmation bar leaves room for the Add button, and page scrolling exposes the final row on small screens.

## Local evidence

- PASS: all 48 Chromium/WebKit navigation, Current, Plan and web-critical journeys, including 10 new Plan cases.
- PASS: seven Plan viewport sizes, both light/dark and Compact/Proportional; no horizontal overflow, readable Compact long titles, reachable final row, density persistence and account separation.
- PASS: quiz cancel/complete, no-check-in prioritization, manual reorder, same-day navigation, next-day reset with identical saved tasks, and retained check-in after switching to Manual.
- Screenshots use synthetic local test tasks only. The owner's reference screenshot is not included.
- PASS: `npm run verify:release` (typecheck, 388 tests across 65 files, production build, server/maintenance fail-closed contracts, client secret/artifact scans).
- PASS: migration static safety, 22 migration hashes, eight Room hashes and 20 durable identifiers. PostgreSQL execution and native-device campaigns were not rerun for this web UI change.

## Scope and deployment

This change is confined to web presentation and interaction, existing quiz wrappers, and their tests. No domain ranking, backend, sync, schema or native-client changes. Full personal-beta readiness is unchanged. The PR deployment comment records the exact commit, Railway deployment and loaded browser asset verification.
