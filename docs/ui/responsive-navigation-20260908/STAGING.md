# Responsive navigation staging candidate — 2026-09-08

The owner authorized staging deployment after approving the responsive header
implementation. This candidate applies only the UI change to the actual staging
source, `6f750a712f253754bfac840d8edc5d846b360b7d`, on
`codex/personal-beta-finalization-20260904`.

The initial implementation was reviewed and tested as
[`3727aae`](https://github.com/mariusschober/Tsurfing/commit/3727aae4444f6815363b04a4a32a1fabf50e2b80)
in [PR #4](https://github.com/mariusschober/Tsurfing/pull/4). Its newer S1/S2 base
was not deployed. The staging candidate preserves the currently deployed
SyncStatus event handler and message precedence, and ports only its button and
panel presentation. No storage, protocol, server, migration, native-client,
authentication or infrastructure configuration file changes are included.

A small fixture harness in `tests/browser/navigationHarness.ts` uses the
existing storage and App interfaces only in the explicit test build. Vite
removes its import in production; the production artifact checks pass and the
built client contains no navigation harness or fixture entry points.

## Repeated validation on the staging base

| Check | Result |
| --- | --- |
| Type checking | PASS |
| Existing suite | PASS: 388 tests in 65 files |
| Production build including web, Mini App and server | PASS |
| Client secret and artifact checks | PASS; test entry points absent |
| Server and maintenance configuration checks | PASS; missing configuration fails closed |
| Migration manifest, Room hashes and durable identifiers | PASS: 22 migrations, 8 Room schemas, 20 identifiers; unchanged |
| Responsive and existing critical web journeys | PASS: 30 tests across Chromium and WebKit; no skips or retries |
| Widths in both themes | PASS: 320, 360, 375, 390, 430, 640, 768, 870, 1023, 1024, 1280, 1440, 1535, 1536 and 1920 CSS pixels |
| Panels, focus, keyboard, touch, short screens, enlarged text and mode behavior | PASS in the browser suite |
| Active task, focus-session identity and music owner continuity | PASS; external media device is simulated |

[Machine-readable staging results](staging-results.json) retain the exact source
hashes, each test result and timing. The different unit-test total from the
original report reflects the older staging base; none of its tests were removed
or skipped.

Screenshots from this candidate: [320px header](staging-screenshots/dark-320-closed.png),
[320px Menu](staging-screenshots/dark-320-menu.png),
[390px light Menu](staging-screenshots/light-390-menu.png),
[1024px header](staging-screenshots/dark-1024-closed.png),
[1440px header](staging-screenshots/dark-1440-closed.png),
[1920px header](staging-screenshots/dark-1920-closed.png).

## Deployment record and rollback

The pull request from `fix/responsive-navigation-staging-20260908` into
`codex/personal-beta-finalization-20260904` is the authoritative live deployment
record. It records the promoted commit, exact GitHub Actions run and outcomes,
Railway deployment IDs, HTTP readiness revision and post-deployment browser
checks. Local results above do not themselves establish deployed acceptance.

Before this update, Railway staging web/API deployment
`2a1caf28-cbbb-4c14-a5c7-b0d734190f2b` served the baseline commit above. Staging
maintenance used the same source branch. Promoting the tested commit by a
fast-forward lets the existing staging GitHub integration deploy that exact
source without changing Railway configuration. Production is outside this
promotion. If the UI requires rollback, revert this UI commit on the staging
branch and verify the newly deployed revision; never reset or force-push shared
history. No database rollback is part of this UI change.

## Boundaries

Physical iOS/Android browsers, hardware safe areas, screen-reader speech,
installed mobile PWAs and audible remote radio playback are not measured.
The original report also contains manual desktop Brave zoom evidence. This is
UI evidence and does not establish complete personal-beta release readiness.

## Reproduce

```sh
npm run lint
npm test
npm run build
npm run test:navigation
```

The isolated staging-candidate browser suite uses port 4188. It starts and
stops its own test server; do not reuse an older build when repeating the checks.
