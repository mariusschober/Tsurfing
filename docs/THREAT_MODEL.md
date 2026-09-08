# Goalflow Threat Model

Scope: first-party web/PWA client, native Kotlin/Compose Android client, Capacitor Android delivery, Express API, Supabase/Postgres, browser/native backup and restore, synchronization, AI proxy, speech proxy, and Telegram integration.

## Assets

- User task, goal, habit, planning, circadian, progress, and statistics data.
- Authentication sessions, recovery email, MFA state, and account identity.
- Encrypted browser and server backups, backup metadata, and restore passwords/keys.
- Telegram identity, chat linkage, capture text, and transient voice transcripts.
- AI provider credentials, OpenAI credentials, Telegram bot credentials, Turnstile secret, Supabase service-role key, and backup master key.

## Trust boundaries

1. Browser JavaScript and IndexedDB/localStorage.
2. Native Android Compose client, Room database, DataStore, Keystore, and WorkManager.
3. Capacitor Android WebView and its packaged web assets.
4. Express API and its process environment.
5. Supabase Auth, Postgres, Storage, RLS, and service-role API.
6. Telegram OIDC, Bot API, webhook, and file download endpoints.
7. AI and speech providers.
8. CI/build artifacts and deployment hosting.

The browser and Android bundle are hostile-readable environments. Only browser-safe Supabase URL/anonymous key, public provider identifiers, and optional API origin may enter them. Service-role, backup, bot, AI, speech, Turnstile, and webhook secrets remain server-only.

## Threats and controls

| Threat | First-party control / verification |
| --- | --- |
| Stored XSS in task, goal, or Telegram text | React escaping; `react-markdown` is not used for untrusted HTML; Telegram output uses explicit HTML escaping. Search and build-output review performed. |
| URL injection or open redirect | No user-controlled navigation target is trusted; external audio is fixed to Telegram/approved providers; browser auth redirects use the current app origin and native auth uses the fixed `goalflow://auth/callback` scheme. |
| CSRF / cross-origin API use | Bearer-token API; explicit CORS allow-list; OPTIONS rejects unknown origins; no cookie-authenticated mutation endpoints. |
| IDOR / cross-user task access | Server queries scope by `request.user.id`; privileged RPCs receive the authenticated user id; RLS policies scope rows by `auth.uid()`. Adversarial policy inspection is recorded below. |
| Privilege escalation / owner endpoints | Owner role checked server-side; owner routes are behind authentication and AAL2 enforcement; invite creation/revocation is owner-scoped. |
| Token/session leakage | Supabase session persistence is client-managed; server verifies tokens with Supabase Auth; logs do not include tokens. |
| Session fixation / forged local demo | `local-demo` is accepted only outside production with both explicit local-demo flags; production rejects it. |
| Brute force / oversized input | Global API rate limit, Telegram-auth rate limit, 256 KB JSON limit, Zod bounds, AI quotas, voice byte limits, and provider timeouts. |
| Hostile backup / wrong password / tampering | Browser backups use PBKDF2-SHA256 plus AES-256-GCM; schema/checksum validation and atomic IndexedDB import. New server backups use a versioned AES-256-GCM envelope with random salt, an HKDF-SHA256 per-user key, authenticated user context, checksum/metadata verification, database dry-run validation, a completed pre-restore snapshot, transactional restore, and post-commit durable-ID checks. Legacy `GFB1` objects remain readable. |
| Secret leakage in client output | Production source maps are disabled; build output is searched for secret names/values; only `VITE_` public settings are documented for the client. |
| Telegram webhook forgery / replay | Telegram secret-token header check; update-id deduplication; identity and user scoping; callback mutations use user-scoped filters/RPCs. |
| Telegram prompt/input abuse | Telegram captures share the bounded scheduling parser; task/title/database constraints and HTML escaping apply; voice downloads are size/time bounded and not retained. |
| AI prompt abuse / provider leakage | Bounded request schemas, quotas, circuit breaker, provider timeouts, response schemas, and server-only provider keys. Logs contain route/latency/category, not prompts or responses. |
| Dependency vulnerability | The required `dependency-audit` job scans the exact npm lockfile with the OSV Scanner action pinned to an immutable commit; a missing lockfile, scanner error, timeout, or known vulnerability fails the aggregate gate. |
| Privacy leakage in logs | HTTP logs contain request metadata and user id only; AI logs contain metadata; backup failures log categories, not plaintext. |
| Native local-data exposure or session theft | Native task data remains in the private app sandbox; sessions use Android Keystore-backed storage; no server secret or provider key is packaged in the native client. The custom auth scheme is fixed but device-level deep-link interception still requires an emulator/device security pass. |

## RLS review

The migrations enable RLS on profiles, sync records, tasks, daily plans, task events, Telegram tables, entitlements, conflicts, backup metadata, invite data, AI usage, and global usage. User-readable policies use `auth.uid() = user_id`; sensitive tables revoke direct authenticated access. Service-role RPCs are explicitly revoked from `public`, `anon`, and `authenticated`, then granted only to `service_role`.

The environment used for this release did not provide two authenticated Supabase identities or a staging project, so live cross-user RLS execution is **NOT AVAILABLE**. The release therefore treats the policy/source inspection as evidence, not as a live tenant-isolation pass. A staging procedure remains: sign in as A and B, attempt selects/mutations against the other user’s task, goal/profile, sync, conflict, and backup metadata rows, and require zero rows/permission errors for all cross-user operations.

## Findings addressed in this pass

- Local recovery reads now prefer the newest recovery copy and preserve deletion tombstones after IndexedDB failure.
- Storage mutations are serialized so immediate write/delete/clear sequences cannot resurrect an older value.
- Backup validation happens before import; IndexedDB imports use one atomic transaction and failed transactions leave the prior recovery copy intact.
- Sync metadata read-modify-write operations are serialized; local conflict resolution is explicit and server conflicts remain visible until the retry is accepted.
- Client API calls support an explicit `VITE_API_ORIGIN` for Android without embedding a development host or credential.
- Telegram `/move` rejects missing/invalid dates instead of silently choosing a different day.
- Month-only database scheduling uses the user profile timezone through a forward-only migration.
- Native Room persistence uses explicit schema migrations, an encrypted Goalflow backup bridge, durable outbox state, retryable WorkManager sync, and dark/light system-bar resources without a WebView main experience.

## Residual external verification

Live Supabase/RLS tests, real Telegram webhook tests, provider fault tests, and device/emulator tests require credentials or infrastructure not present in this environment. They are reported as `NOT AVAILABLE`, never as passing evidence.
