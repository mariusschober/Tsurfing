# Local Mac staging install — 2026-09-07

The running Xcode Debug app was 0.4.0 (3), with blank API origin, Supabase URL
and publishable key. It could not authenticate or sync. The updated local
build uses the current finalization source d45fd96 plus the previously saved
Mac auth fix 2378b18 (CAPTCHA policy and preserving sessions awaiting MFA).

The local Debug build explicitly opts into `DEBUG TSURFING_LOCAL_KEYCHAIN`.
It uses the macOS login keychain because this Mac has no valid developer
signing identity and the data-protection keychain returned -34018. Release
builds still require the data-protection keychain: there is no runtime
fallback, plaintext storage, or release-mode opt-in. This local application
is ad-hoc signed, not a signed/notarized distribution release.
Apple reference: https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains

Cloud and planner origin: https://staging.tsurfing.com
Supabase project: xyjgpwwvsyjhurkycyqr
Environment: staging; Telegram: enabled; provider: custom:telegram.
Only the public client key from the deployed staging client is embedded.
No server keys, session tokens or owner login codes are included in source.

The web planner follows the configured API origin. Staging builds do not
use the production update channel; they are installed locally. Settings
reports the real bundle version and environment and offers a persistent
Account / Sign in panel for entering codes after switching to email.

Verification: 195 Mac tests passed, zero failed, one skipped. The skipped
live transport test belongs to the separately invoked cross-client staging
gate. The passing tests include a real macOS keychain write/read/delete
round trip using a unique test-only service. The subsequent Settings-only
change was rebuilt and requires UI verification. Build 2026090704, version
0.4.0, is the configured install candidate at /Applications/Tsurfing.app.
Existing local task files and their identities are retained; local data was
backed up under ~/Library/Application Support/Tsurfing-install-backups/.

Full owner authentication and authenticated live sync require completion
inside the installed app; local tests do not establish those outcomes.
