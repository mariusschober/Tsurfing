# Mac sync and ticking recovery — 7 September 2026

## Cause and change

Installed build 2026090707 rejected web terminal task payloads: web uses completed=true for dropped/archived tasks, whereas Android treats completed as successful completion only. The Mac decoder incorrectly treated those compatible terminal representations as contradictory, blocking the entire pull page. The decoder now accepts both terminal-removal representations, keeps them out of the active queue, and still rejects contradictory open/completed states and invalid boolean types. Native serialization emits terminal flags that the web cannot mistake for an open task.

The Mac now uses the deployed automatic reconciliation endpoint introduced by web/API commit b2a1deea3c350ead18dd0bfc92632c13d865255f. It submits original history and timestamps, verifies the exact candidate echo and receipt identity plus canonical record identity/revision, and commits values and metadata through the existing durable journal. Concurrent edits and changed history are preserved. No original receipt or mutation payload is rewritten. Routine manual-conflict controls are replaced by automatic-sync status.

TickSoundGateway existed, but MenuBarController constructed the execution model with NoopSoundGateway. The timer binding also emitted sounds only when overtime changed. The app now injects the real sound gateway, emits a single tick when countdown or overtime advances, stays silent on pause or repeated time, and exposes ticking mute, volume, and preview controls. The audio graph is retained through playback and pauses after ticking stops. A preview deliberately plays one sound without starting a task or changing task history.

## Verification and installed build

- Configured full macOS suite: 206 passed, 0 failed, 1 explicit live cross-client test skipped.
- Regression coverage includes web/Android terminal-removal compatibility, invalid flags, exact/mismatched/stale acknowledgments, replay, concurrent local edits, changed conflict history, duplicate mutation IDs, and countdown/overtime/pause timing.
- Xcode source membership and git diff checks passed.
- Built and installed /Applications/Tsurfing.app, version 0.4.0 build 2026090708.
- Strict code-signature verification passed. All six public staging configuration values match the previous installed build. The existing DEBUG TSURFING_LOCAL_KEYCHAIN opt-in is retained; no account/session/keychain data was cleared.
- Previous app and consistent local-data backup: ~/Library/Application Support/Tsurfing-install-backups/20260907-124348-sync-ticking.
- After startup, the existing account synchronized automatically: outbox 0, conflicts 0 (previously 12), cursor 1567, successful sync 2026-09-07T11:44:02Z.
- All five open native task IDs, titles, dates, positions and frog flags matched a live read of the authoritative cloud records. Four tasks are assigned today. E-Mail an Harald Lange is the priority task.
- UI tools could read the original failing popover, but cannot bind the new menu-bar-only app while its panel is closed. The owner was asked to leave the panel open. Audible output and final panel appearance remain NOT MEASURED at this checkpoint; no microphone recording or owner task edit was used as a substitute.

This patch is based on the configured Mac staging branch, which retains the earlier Mac keychain, staging-origin, menu-bar contrast, and daily-plan fixes. It is not a promotion of this branch over the newer web finalization branch and does not redeploy web/Android or production.
