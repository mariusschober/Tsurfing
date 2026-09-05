# Native Android client

Tsurfing has two Android delivery targets:

- `android-native/` is the native Kotlin + Jetpack Compose client described by
  the Android UX plan. It uses Room for product state, DataStore for UI
  preferences, WorkManager for optional synchronization, and Android Keystore
  for the cloud session.
- `android/` remains the existing Capacitor/WebView compatibility target. It is
  kept independently so the web/PWA delivery path is not coupled to native
  client changes.

The native client does not use a WebView for its main experience. It preserves
the existing Tsurfing vocabulary and rules: Current executes one deterministic
commitment, Planning confirms the order, monthly work needs an exact day,
frogs retain their anti-avoidance constraints, and local actions do not wait
for cloud services.

## Native surface

The current native client includes:

- cold/warm launch into local state and first-run capture;
- capture from the launcher shortcut and Android text-share intent;
- exact-day and future-month scheduling with native date picking;
- Current, focus timing, completion, undo, breakdown, explicit drop, and
  completion recovery after reload/process death;
- Planning with overdue/month conversion, move buttons, long-press reorder,
  local undo, and the explicit daily-plan gate;
- task editing, frogs, habits, Goals, True North, background thought, Insights,
  circadian check-in, encrypted backup/restore, typed email-code or Telegram
  sign-in, explicit Telegram linking, and sync conflict choices.

AI remains optional. Telegram is compile-time disabled until its environment's
custom OIDC provider is proven. Native Room preserves web-owned collections it
does not edit, so using the native client does not silently discard those
records.

## Build variants

| Variant | Application ID | Label | Purpose |
| --- | --- | --- | --- |
| `productionDebug` | `com.mariusschober.tsurfing.dev` | Tsurfing | Local/debug production-auth path |
| `productionRelease` | `com.mariusschober.tsurfing` | Tsurfing | Signed only with complete explicit release credentials; ordinary CI compiles it unsigned with `-PgoalflowSkipSigning=true` |
| `sandboxDebug` | `com.mariusschober.tsurfing.sandbox.dev` | Tsurfing Test | Isolated local test build; entry code `123456` |

The sandbox gate is compile-time flavor configuration. It is not present in
the production flavor, and sandbox data is isolated by the separate package
identity. No production credential or fake hosted account is required for
local use.

Cloud-enabled builds take these non-secret Gradle properties from the command
line or the developer's untracked Gradle properties file:

```properties
goalflowApiOrigin=https://api.example.test
goalflowSupabaseUrl=https://project-ref.supabase.co
goalflowSupabasePublishableKey=sb_publishable_example
goalflowTelegramEnabled=false
goalflowTelegramOidcProviderId=custom:telegram
```

Only the Supabase publishable key belongs in the APK. A Supabase secret or
service-role key must never be supplied to Gradle. Supabase Auth must allow the
native redirect `tsurfing://auth/callback` and the narrowly scoped
`tsurfing://auth/callback?state=*` pattern in the matching staging or production
project. Telegram requests append a random, locally verified state value; the
bare URL alone does not allow that callback. Keep the callback scheme, host, and
path fixed. When Telegram is enabled, the provider identifier must use
the `custom:` prefix. Supabase owns provider OAuth state and PKCE; the native
client retains only its one-use verifier and callback nonce in encrypted local
storage.

## Local commands

From the repository root, with Java 21 and an Android SDK installed:

```bash
./android-native/gradlew -p android-native test
./android-native/gradlew -p android-native lint
./android-native/gradlew -p android-native assembleProductionDebug
./android-native/gradlew -p android-native assembleProductionRelease
./android-native/gradlew -p android-native assembleSandboxDebug
./android-native/gradlew -p android-native :app:assembleProductionDebugAndroidTest
./android-native/gradlew -p android-native :benchmark:assemble
```

For a connected Android device, run the compiled instrumentation suites with:

```bash
./android-native/gradlew -p android-native :app:connectedProductionDebugAndroidTest
./android-native/gradlew -p android-native :benchmark:connectedCheck
```

The installable native debug APKs are produced at:

```text
android-native/app/build/outputs/apk/production/debug/
android-native/app/build/outputs/apk/sandbox/debug/
```

The native Gradle wrapper, JVM 21 alignment, Room migrations, and test-only
JSON runtime are committed. Production release signing material is not. When a
release job supplies a base64 keystore, Gradle decodes it into a unique
owner-readable temporary file and requires deletion at build completion.

## Reliability boundaries

Product state is written to Room before synchronization is scheduled. The
outbox is durable and causally ordered; WorkManager retries network work, but
the UI never waits for it. Push acknowledgements and pull cursors are accepted
only after exact payload/version checks. Conflicts retain both sides until the
user chooses explicitly.

Native email sign-in requests a server-bound attempt, verifies the typed
six-digit code directly with Supabase, and exposes the encrypted session only
after activation succeeds. Telegram uses Authorization Code + PKCE in the
system browser, accepts only `tsurfing://auth/callback` with the matching local
nonce, and validates the immutable Supabase UUID with the application server
before exposing a session. Implicit token fragments are rejected. Link failures
cannot replace or erase the current account. Sign-out clears the local session
before revoking only that Supabase session, so an in-flight sync cannot continue
with a detached account.

Encrypted backups retain the legacy Goalflow AES-256-GCM/PBKDF2 envelope for
compatibility. Decryption,
schema, checksum, identity, and outbox-dependency validation happen before a
replace restore transaction. A failed restore leaves the current database
untouched.

## CI and unavailable runtime checks

The `native-android` GitHub Actions job runs the native JVM/Room/domain/sync/
backup/focus suite, compiles the app instrumentation APK and the real
Macrobenchmark source, runs lint, assembles production debug/release and
sandbox debug, and uploads both native debug APKs from a clean checkout. The
separate `android` job continues to run Capacitor sync, wrapper tests/lint, and
wrapper APK assembly.

Emulator/device lifecycle tests, screenshot tests, TalkBack runtime checks,
Macrobenchmark timing execution, and offline process-death execution require an
Android runtime and are reported as `NOT AVAILABLE` when no emulator/device is
provided. A successful source compile or APK assembly is not presented as
evidence for those runtime behaviors. The target app is marked `profileable`
and includes `ProfileInstaller` so a physical-device run is ready to collect
startup and frame data.

### Email verification availability

Android reads `/api/v1/auth/email/config` before enabling a new email-code
request. Only an explicit Boolean `captchaRequired: false` permits a request
without a verification token. An unavailable or malformed response leaves the
request disabled with a visible retry action. When the server requires CAPTCHA,
the hosted challenge must succeed; HTTP failures are shown in the dialog. The
server remains responsible for enforcing its policy on every request.

Owner MFA is a step-up requirement, not session revocation. A sync response of
HTTP 403 with `error.code = mfa_required` pauses sync while retaining the AAL1
session and pending Room mutations. Verifying the authenticator elevates that
same account and wakes sync. HTTP 401 and other HTTP 403 responses still follow
the existing authentication-expiry handling.
