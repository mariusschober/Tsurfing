# Natural date capture and Mac notes focus — 2026-09-07

Command-Return in Mac Quick Capture opens and focuses the notes editor; repeated use retains notes focus. The title and notes editors use distinct SwiftUI focus targets. The actual AppKit key-equivalent regression test types into notes and checks that the title remains unchanged.

Web/PWA, Mac, Android capture and Telegram capture recognize today, tomorrow, next week, next month, English month names, and `in N days/weeks/months`. Weekday names remain supported. Web and Telegram share one date parser; native parsers have matching calendar examples. Month phrases use future-month planning; day/week offsets use exact local dates. Next week means seven days ahead. A named month without a year resolves to its next future occurrence, including next year if that month is already current or past. Bare `months` has no determinable date and stays in the title. Lowercase verbs `may` and `march` are retained unless used with `in` or an explicit year. Only a recognized date phrase is removed from the saved title; notes are not parsed.

All arithmetic starts from the client's local day (Telegram's supplied local day), with calendar date arithmetic independent of daylight-saving offsets. No sync protocol, schema, receipt, WAL, or outbox changes are included.

Verification:
- Web final release checks PASS: 65 files / 388 tests; TypeScript, client/Mini App/API builds, server and maintenance startup, client secret and artifact checks.
- Isolated Chromium capture journey PASS: next-month preview and persisted task both retain month precision.
- Mac targeted capture/scheduling suites PASS: 38 tests, including keyboard focus and calendar parsing. Full configured suite was interrupted while blocked in the unrelated real-Keychain test; no full-suite pass is claimed.
- Android unit tests PASS: 137 tests, 1 skip, no failures/errors; production-debug lint and configured APK build PASS.
- Mac build 2026090718 installed with existing public configuration, login behavior, and local data retained; strict code-signature verification PASS. Backup: ~/Library/Application Support/Tsurfing-install-backups/20260907-153344-natural-capture.
- Android configured update installed successfully with replacement mode on the existing TCL device, without data clearing. The new capture journey was not manually exercised on the physical device.

Source is isolated in `/private/tmp/tsurfing-natural-capture`, branch `feat/natural-capture-20260907`, based on bfb94c7. Unfinished sync experiments and unrelated dirty files remain in their original checkouts and are excluded.
