# Responsive web navigation verification

**Evidence scope:** the original implementation report below applies to commit
`3727aae4444f6815363b04a4a32a1fabf50e2b80`. For the UI-only candidate based on
the actual deployed staging version, see [staging verification](STAGING.md).

The header now fits from 320 CSS pixels upward. Mobile uses a labelled Menu;
laptop widths retain all five primary destinations; wide screens also show the
secondary controls. Manual / Bio-Adaptive lives in Plan and Current.

This is an isolated web UI change based on
`8eb51dd6ff9b05e47e5c0250da2550f03920bbf1` from
`codex/s2-causal-counters-20260907`. It changes no hooks, domain types, task or
timer rules, storage, sync derivation, server code, authentication, or native
clients. The shared checkout's concurrent protocol work remains separate.

## Verification

| Check | Result |
| --- | --- |
| Type checking (`npm run lint`) | PASS |
| Production web build (`npm run build:client`) | PASS |
| Existing test suite (`npm test`) | PASS: 528 tests, 85 files |
| Responsive and existing web journeys (`npm run test:navigation`) | PASS: 30 tests, Chromium and WebKit, no skips or retries |
| Existing sync retry/error UI journeys | PASS: 4 checks across Chromium and WebKit; only accessible-name selectors were updated |
| Repeated short-screen regression | PASS: 3 runs per browser after correcting border-inclusive panel height |
| Width matrix in both themes | PASS: 320, 360, 375, 390, 430, 640, 768, 870, 1023, 1024, 1280, 1440, 1535, 1536, 1920 |
| Menu, sync and music panels | PASS: viewport fit, vertical scrolling, outside click, Close, Escape, focus containment/restoration |
| Resizing with panels open | PASS: portrait/landscape, short height, both layout transitions, trigger removal |
| Input and accessibility | PASS: keyboard and emulated touch, labelled controls, active/expanded state, 44px navigation targets, background inactivity |
| Enlarged text and long strings | PASS: 200% root font size, long account/diagnostic text, reduced motion |
| Task and mode continuity | PASS: active task and focus-session identity survive resizing/Menu; Plan and Current agree; cancelled check-in preserves the mode; Manual uses the existing reset |
| Music continuity | PASS with a simulated media device: one Audio owner, unchanged playback/station/volume across controls moving and header hiding |
| Brave visual review | PASS locally: compact Menu, Plan mode placement, laptop layout, sync panel |
| Native Brave zoom | PASS at 200%; PASS at 400% from a 1280px viewport (320 CSS pixels) |

At 400% zoom the Menu occupied x=12–308 and y=12–213 within a 320×225 CSS-pixel
viewport. The Close control stayed visible while the body scrolled. Sign out
could be fully exposed at y=152–196. Browser zoom and the temporary viewport
override were restored after testing.

The original sandboxed `npm test` attempt could not bind local server sockets;
the same unchanged suite passed with loopback access. Simulated credential-gate
failure messages in that suite are expected negative-test output.

## Matched screenshots

These use an empty synthetic account and the same Current screen, dark theme,
900px height and Chromium engine before and after. The baseline is the commit
above, rather than live staging data. Different sync text accounts for the
small difference from the earlier live audit's overflow measurements.

| Width | Before | After | Header-created document overflow before → after |
| --- | --- | --- | --- |
| 320 | [Before](screenshots/before-dark-320.png) | [After](screenshots/after-dark-320-closed.png) | 0 → 0; hidden navigation strip replaced |
| 390 | [Before](screenshots/before-dark-390.png) | [After](screenshots/after-dark-390-closed.png) | 0 → 0; hidden navigation strip replaced |
| 1024 | [Before](screenshots/before-dark-1024.png) | [After](screenshots/after-dark-1024-closed.png) | 420px → 0 |
| 1440 | [Before](screenshots/before-dark-1440.png) | [After](screenshots/after-dark-1440-closed.png) | 84px → 0 |
| 1920 | [Before](screenshots/before-dark-1920.png) | [After](screenshots/after-dark-1920-closed.png) | 0 → 0 |

Additional views: [320px Menu](screenshots/after-dark-320-menu.png),
[390px Menu](screenshots/after-dark-390-menu.png),
[light mobile Menu](screenshots/after-light-390-menu.png),
[light laptop header](screenshots/after-light-1024-closed.png).

[Machine-readable results](results.json) include test outcomes, timing, source
hashes, baseline widths, active-task widths and the manual zoom measurements.
The active-task scenario also had zero document overflow at 320, 390, 870, 1024
and 1536px in both browser engines. No unrelated view-layout defect was found in
that scenario; this is not a claim about every content state elsewhere.

## Remaining verification boundaries

- At this original implementation checkpoint staging was unchanged. The owner
  subsequently authorized deployment; [staging verification](STAGING.md) records
  the separately tested adaptation to the deployed source line.
- Physical iOS Safari, Android Chrome, hardware safe areas, mobile keyboards,
  screen-reader speech and an installed mobile PWA have not been measured.
  WebKit and touch emulation are local browser evidence.
- Actual remote radio decoding and audible output were not measured. The
  continuity tests exercise the real player component against a simulated
  media device.
- The remote protocol branch advanced independently to `08cee83` during this
  work. Its five new commits do not overlap this UI diff. Local results apply
  to the isolated UI branch; combined upstream acceptance is a separate check.
- This report establishes UI scope only; it does not assert beta release or
  cross-client synchronization readiness.

## Reproduce

```sh
npm run lint
npm test
npm run build:client
npm run test:navigation
```

The navigation config serves the isolated test build at port 4186. If reusing
an already-running preview, run `npm run build:client:test` first so the tests
load the current code and test harness. The normal CI browser configuration
also discovers `navigation-responsive.spec.ts` automatically.
