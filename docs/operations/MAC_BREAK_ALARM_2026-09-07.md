# Mac break alarm and status repair — 7 September 2026

The expiry publisher emitted `true` every second after a break reached zero.
Three view-model paths could start an alarm, while the audio implementation
blocked its serial queue with repeated bursts and `stopAlarm()` did nothing.
That accumulated a backlog which could continue after the break closed.

Commit f866311 changes expiry into one finite notification per break. Repeated
ticks and restores cannot retrigger it. Alarm audio has its own non-blocking
queue and retained graph; cancellation invalidates queued starts and stops
current output. The three-beep alert lasts 0.75 seconds. Dismissal, a different
break and normal app termination all stop alarm output.

The expired fullscreen overlay and panel say “Continue work”, including the
Escape hint and accessibility label. Continuing an expired break resumes the
paused focus session. Early dismissal retains the previous paused behavior.
The menu-bar title no longer embeds emoji alongside the AppKit status symbol.
There is one icon for paused, active, overtime and break states.

Validation: 209 macOS tests passed, 0 failed, 1 explicit live cross-client test
skipped. New regressions cover repeated expiry updates/restores, cancellation,
open-ended breaks and notification on the next break. Build 2026090711 was
installed and relaunched with strict signature verification and unchanged
staging configuration. Login and local data were retained; the previous app
and consistent data backup are in:
~/Library/Application Support/Tsurfing-install-backups/20260907-131455-break-alarm.

The menu-bar-only app still could not be bound by the native UI inspection tool.
Live speaker output and final panel appearance were not independently observed.
Cross-client active timer synchronization is separate work; this commit alone
does not add it.
