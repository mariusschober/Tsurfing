package com.mariusschober.goalflow.nativeapp.sync

import android.content.Intent
import android.net.Uri
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom

class NativeAuthException(message: String) : IllegalStateException(message)
class NativeAuthTransientException(message: String) : IOException(message)

data class NativeAccountProfile(
    val userId: String,
    val email: String,
    val role: String,
    val assuranceLevel: String
)

data class NativeTelegramStatus(
    val enabled: Boolean,
    val linked: Boolean,
    val username: String?
)

/** Typed Supabase email OTP with server-bound approval and encrypted state. */
open class NativeAuthClient(
    private val sessionStore: SecureSessionStore,
    private val isAuthEnabled: () -> Boolean = { NativeConfig.canUseAuthentication },
    private val supabaseUrl: String = NativeConfig.supabaseUrl,
    private val supabasePublicKey: String = NativeConfig.supabasePublicKey,
    private val apiOrigin: String = NativeConfig.apiOrigin,
    private val authRedirectUri: String = NativeConfig.authRedirectUri,
    private val telegramEnabled: () -> Boolean = { NativeConfig.canUseTelegram },
    private val telegramProviderId: String = NativeConfig.telegramOidcProviderId
) {
    suspend fun emailCaptchaRequired(): Boolean = withContext(Dispatchers.IO) {
        requireSafeAuthConfiguration()
        val response = request(
            url = "$apiOrigin/api/v1/auth/email/config",
            method = "GET",
            body = null,
            headers = emptyMap()
        )
        val required = if (response.code == 200) {
            runCatching { JSONObject(response.body).opt("captchaRequired") }.getOrNull()
        } else null
        if (required !is Boolean) {
            throw NativeAuthException("Sign-in settings could not load. Check the connection and try again.")
        }
        required
    }

    suspend fun requestEmailCode(
        email: String,
        purpose: String = "sign_in",
        inviteCode: String = "",
        captchaToken: String = ""
    ): PendingEmailOtpAttempt = withContext(Dispatchers.IO) {
        requireSafeAuthConfiguration()
        val cleanEmail = email.trim().lowercase()
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(cleanEmail).matches()) {
            throw NativeAuthException("Enter a valid email address.")
        }
        if (purpose !in setOf("sign_in", "activation")) {
            throw NativeAuthException("The email-code request type is invalid.")
        }
        if (purpose == "activation" && inviteCode.trim().length !in 6..128) {
            throw NativeAuthException("Enter a valid beta invite.")
        }
        val body = JSONObject().apply {
            put("email", cleanEmail)
            put("purpose", purpose)
            put("code", if (purpose == "activation") inviteCode.trim() else "")
            put("captchaToken", captchaToken)
        }
        val response = request(
            url = "$apiOrigin/api/v1/auth/email/preflight",
            method = "POST",
            body = body.toString(),
            headers = emptyMap()
        )
        if (response.code !in 200..299) {
            if (isRetryableStatus(response.code)) {
                throw NativeAuthTransientException("Email-code delivery is temporarily unavailable. Local commitments remain available.")
            }
            throw NativeAuthException("Email-code delivery could not be started.")
        }
        val result = runCatching { JSONObject(response.body) }.getOrNull()
            ?: throw NativeAuthException("The authentication server returned invalid data.")
        val attemptToken = result.optString("attemptToken")
            .takeIf { it.matches(OPAQUE_TOKEN_PATTERN) }
            ?: throw NativeAuthException("The authentication server returned invalid request authority.")
        val expiresInSeconds = result.optLong("expiresInSeconds", 0L).takeIf { it in 1L..600L }
            ?: throw NativeAuthException("The authentication server returned an invalid expiry.")
        val resendAfterSeconds = result.optLong("resendAfterSeconds", 0L).takeIf { it in 60L..600L }
            ?: throw NativeAuthException("The authentication server returned an invalid resend cooldown.")
        val now = System.currentTimeMillis()
        val attempt = PendingEmailOtpAttempt(
            attemptToken = attemptToken,
            email = cleanEmail,
            purpose = purpose,
            expiresAtMillis = now + expiresInSeconds * 1_000L,
            resendAtMillis = now + resendAfterSeconds * 1_000L
        )
        abandonPendingAccountAuthentication()
        sessionStore.setPendingEmailOtp(attempt)
        attempt
    }

    suspend fun verifyEmailCode(email: String, code: String): NativeSession = withContext(Dispatchers.IO) {
        requireSafeAuthConfiguration()
        val cleanEmail = email.trim().lowercase()
        val cleanCode = code.trim()
        val attempt = sessionStore.getPendingEmailOtp()
            ?: throw NativeAuthException("Request a new email code on this device.")
        if (attempt.expiresAtMillis <= System.currentTimeMillis()) {
            sessionStore.clearPendingEmailOtp()
            throw NativeAuthException("The email-code request expired. Request a new code.")
        }
        if (!secureEquals(cleanEmail, attempt.email) || !cleanCode.matches(EMAIL_OTP_PATTERN)) {
            throw NativeAuthException("Enter the six-digit code sent to this email address.")
        }
        // Retry only if this exact encrypted session was produced by the
        // earlier OTP verification. A pre-existing session must never skip
        // the typed code.
        sessionStore.read()?.takeIf { attempt.matchesVerifiedSession(it) }?.let { existing ->
            activateEmailOtp(existing, attempt)
            return@withContext existing
        }
        val response = request(
            url = "$supabaseUrl/auth/v1/verify",
            method = "POST",
            body = JSONObject()
                .put("email", cleanEmail)
                .put("token", cleanCode)
                .put("type", "email")
                .toString(),
            headers = authHeaders()
        )
        if (response.code !in 200..299) {
            if (isRetryableStatus(response.code)) {
                throw NativeAuthTransientException("Email verification is temporarily unavailable. Try again without requesting another code.")
            }
            throw NativeAuthException("The email code is invalid or expired.")
        }
        val session = parseSessionResponse(response.body)
        sessionStore.write(session)
        val verifiedAttempt = attempt.copy(
            verifiedUserId = session.userId,
            verifiedAccessTokenHash = accessTokenHash(session.accessToken)
        )
        sessionStore.setPendingEmailOtp(verifiedAttempt)
        activateEmailOtp(session, verifiedAttempt)
        session
    }

    suspend fun resumePendingEmailActivation(): NativeSession? = withContext(Dispatchers.IO) {
        val attempt = sessionStore.getPendingEmailOtp() ?: return@withContext null
        val session = sessionStore.read() ?: return@withContext null
        if (!attempt.matchesVerifiedSession(session)) return@withContext null
        // Let the server decide expiry: an activation committed before a lost
        // response remains an exact idempotent success after ten minutes.
        activateEmailOtp(session, attempt)
        session
    }

    suspend fun beginTelegramSignIn(): Uri = withContext(Dispatchers.IO) {
        requireSafeTelegramConfiguration()
        val pending = newOAuthRequest(NativeOAuthFlow.TELEGRAM_SIGN_IN)
        abandonPendingAccountAuthentication()
        sessionStore.setPendingOAuth(pending)
        telegramAuthorizeUrl(pending, linkIdentity = false)
    }

    suspend fun beginTelegramActivation(inviteCode: String, captchaToken: String): Uri = withContext(Dispatchers.IO) {
        requireSafeTelegramConfiguration()
        val cleanInvite = inviteCode.trim()
        if (cleanInvite.length !in 6..128) throw NativeAuthException("Enter a valid beta invite.")
        val response = request(
            url = "$apiOrigin/api/v1/auth/telegram/preflight",
            method = "POST",
            body = JSONObject().put("code", cleanInvite).put("captchaToken", captchaToken).toString(),
            headers = emptyMap()
        )
        if (response.code !in 200..299) {
            if (isRetryableStatus(response.code)) {
                throw NativeAuthTransientException("Telegram sign-in is temporarily unavailable. Local commitments remain available.")
            }
            throw NativeAuthException("Telegram beta access could not be started.")
        }
        val result = runCatching { JSONObject(response.body) }.getOrNull()
            ?: throw NativeAuthException("The authentication server returned invalid data.")
        val attemptToken = result.optString("attemptToken").takeIf { it.matches(OPAQUE_TOKEN_PATTERN) }
            ?: throw NativeAuthException("The authentication server returned invalid request authority.")
        if (result.optString("provider") != telegramProviderId) {
            throw NativeAuthException("The authentication server returned an unexpected identity provider.")
        }
        val expiresInSeconds = result.optLong("expiresInSeconds", 0L).takeIf { it in 1L..600L }
            ?: throw NativeAuthException("The authentication server returned an invalid expiry.")
        val pending = newOAuthRequest(
            flow = NativeOAuthFlow.TELEGRAM_ACTIVATION,
            attemptToken = attemptToken,
            expiresInMillis = expiresInSeconds * 1_000L
        )
        abandonPendingAccountAuthentication()
        sessionStore.setPendingOAuth(pending)
        telegramAuthorizeUrl(pending, linkIdentity = false)
    }

    /** Returns null when the verified Telegram identity was already attached. */
    suspend fun beginTelegramLink(): Uri? = withContext(Dispatchers.IO) {
        requireSafeTelegramConfiguration()
        val current = currentSession()
            ?: throw NativeAuthException("Sign in before linking Telegram.")
        val profile = validateServerSession(current)
        if (profile.role == "owner" && profile.assuranceLevel != "aal2") {
            throw NativeAuthException("Verify the owner session before linking Telegram.")
        }
        if (hasTelegramIdentity(current)) {
            activateTelegramLink(current)
            return@withContext null
        }
        val currentUserId = current.userId?.takeIf { it.matches(UUID_PATTERN) }
            ?: throw NativeAuthException("The signed-in account has no stable identity.")
        val pending = newOAuthRequest(
            flow = NativeOAuthFlow.TELEGRAM_LINK,
            expectedUserId = currentUserId
        )
        sessionStore.setPendingOAuth(pending)
        val authorizationEndpoint = telegramAuthorizeUrl(pending, linkIdentity = true)
        val response = request(
            url = authorizationEndpoint.toString(),
            method = "GET",
            body = null,
            headers = authHeaders(current.accessToken)
        )
        if (response.code !in 200..299) {
            if (!isRetryableStatus(response.code)) sessionStore.clearPendingState()
            if (isRetryableStatus(response.code)) throw NativeAuthTransientException("Telegram linking is temporarily unavailable.")
            throw NativeAuthException("Telegram identity linking could not be started.")
        }
        val providerUrl = runCatching { JSONObject(response.body).optString("url") }
            .getOrNull()?.takeIf(String::isNotBlank)?.let(Uri::parse)
            ?: run {
                sessionStore.clearPendingState()
                throw NativeAuthException("The identity provider returned an invalid authorization URL.")
            }
        if (providerUrl.scheme != "https" || providerUrl.host.isNullOrBlank() || providerUrl.userInfo != null) {
            sessionStore.clearPendingState()
            throw NativeAuthException("The identity provider returned an unsafe authorization URL.")
        }
        providerUrl
    }

    suspend fun telegramStatus(): NativeTelegramStatus = withContext(Dispatchers.IO) {
        requireSafeTelegramConfiguration()
        val session = currentSession() ?: throw NativeAuthException("Sign in to view Telegram access.")
        val response = request(
            url = "$apiOrigin/api/v1/account/telegram",
            method = "GET",
            body = null,
            headers = authHeaders(session.accessToken)
        )
        requireAuthenticatedApiResponse(response, session, "Telegram status could not be loaded.")
        val result = runCatching { JSONObject(response.body) }.getOrNull()
            ?: throw NativeAuthException("The authentication server returned invalid data.")
        NativeTelegramStatus(
            enabled = result.optBoolean("enabled", false),
            linked = result.optBoolean("linked", false),
            username = result.optString("username").takeIf(String::isNotBlank)
        )
    }

    suspend fun unlinkTelegram(): NativeTelegramStatus = withContext(Dispatchers.IO) {
        requireSafeTelegramConfiguration()
        val session = currentSession() ?: throw NativeAuthException("Sign in before disconnecting Telegram.")
        val profile = validateServerSession(session)
        if (profile.role == "owner" && profile.assuranceLevel != "aal2") {
            throw NativeAuthException("Verify the owner session before disconnecting Telegram.")
        }
        val response = request(
            url = "$apiOrigin/api/v1/account/telegram/link",
            method = "DELETE",
            body = null,
            headers = authHeaders(session.accessToken)
        )
        requireAuthenticatedApiResponse(response, session, "Telegram access could not be revoked.")
        NativeTelegramStatus(enabled = true, linked = false, username = null)
    }

    suspend fun resumePendingTelegramFlow(): NativeAccountProfile? = withContext(Dispatchers.IO) {
        val pending = pendingOAuthRequest() ?: return@withContext null
        if (pending.flow == NativeOAuthFlow.LEGACY) return@withContext null
        val session = sessionStore.read() ?: return@withContext null
        if (!pending.matchesVerifiedSession(session)) return@withContext null
        finishTelegramFlow(session, pending)
    }

    suspend fun currentSession(): NativeSession? = withContext(Dispatchers.IO) {
        if (sessionStore.getPendingEmailOtp() != null) return@withContext null
        val pendingOAuth = pendingOAuthRequest()
        if (pendingOAuth?.flow in setOf(NativeOAuthFlow.TELEGRAM_SIGN_IN, NativeOAuthFlow.TELEGRAM_ACTIVATION)) {
            return@withContext null
        }
        val current = sessionStore.read() ?: return@withContext null
        // Proactive refresh 5 minutes before expiry to avoid race with sync
        if (current.expiresAtMillis > System.currentTimeMillis() + 5 * 60_000L) return@withContext current
        if (current.expiresAtMillis > System.currentTimeMillis() + EXPIRY_SAFETY_WINDOW_MILLIS) {
            // Try refresh in background, but return current if still valid
            return@withContext try { refresh(current.refreshToken) } catch (_: IOException) { current }
        }
        refresh(current.refreshToken)
    }

    suspend fun refreshIfNeeded(): NativeSession? = currentSession()

    suspend fun completeMfa(code: String): NativeSession = withContext(Dispatchers.IO) {
        requireSafeAuthConfiguration()
        val cleanCode = code.trim()
        if (!cleanCode.matches(Regex("^[0-9]{6}$"))) {
            throw NativeAuthException("Enter the six-digit authenticator code.")
        }
        val current = sessionStore.read()
            ?: throw NativeAuthException("Sign in before verifying the owner session.")
        if (current.assuranceLevel == "aal2") return@withContext current

        val userResponse = request(
            url = "$supabaseUrl/auth/v1/user",
            method = "GET",
            body = null,
            headers = authHeaders(current.accessToken)
        )
        requireMfaResponse(userResponse, current, "The authenticator enrollment could not be loaded.")
        val factors = runCatching { JSONObject(userResponse.body).optJSONArray("factors") }
            .getOrNull()
            ?: throw NativeAuthException("Enroll an authenticator in the web app before verifying this device.")
        val factorId = (0 until factors.length())
            .mapNotNull { factors.optJSONObject(it) }
            .firstOrNull {
                it.optString("factor_type") == "totp" && it.optString("status") == "verified"
            }
            ?.optString("id")
            ?.takeIf { it.matches(UUID_PATTERN) }
            ?: throw NativeAuthException("Enroll an authenticator in the web app before verifying this device.")
        requireUnchangedSession(current)

        val challengeResponse = request(
            url = "$supabaseUrl/auth/v1/factors/$factorId/challenge",
            method = "POST",
            body = JSONObject().put("factorId", factorId).toString(),
            headers = authHeaders(current.accessToken)
        )
        requireMfaResponse(challengeResponse, current, "The authenticator challenge could not be created.")
        val challenge = runCatching { JSONObject(challengeResponse.body) }.getOrNull()
            ?: throw NativeAuthException("The authentication server returned invalid challenge data.")
        val challengeId = challenge.optString("id").takeIf { it.matches(UUID_PATTERN) }
            ?: throw NativeAuthException("The authentication server returned invalid challenge data.")
        if (challenge.optString("type") != "totp") {
            throw NativeAuthException("The authentication server returned an unsupported challenge.")
        }
        requireUnchangedSession(current)

        val verifyResponse = request(
            url = "$supabaseUrl/auth/v1/factors/$factorId/verify",
            method = "POST",
            body = JSONObject().put("challenge_id", challengeId).put("code", cleanCode).toString(),
            headers = authHeaders(current.accessToken)
        )
        requireMfaResponse(verifyResponse, current, "The authenticator code was not accepted.")
        val elevated = parseSessionResponse(verifyResponse.body, current.refreshToken)
        if (elevated.userId != current.userId || elevated.assuranceLevel != "aal2") {
            throw NativeAuthException("The verified session did not match this account at AAL2.")
        }
        requireUnchangedSession(current)
        sessionStore.write(elevated)
        elevated
    }

    suspend fun acceptCallback(intent: Intent?): Boolean = withContext(Dispatchers.IO) {
        val uri = intent?.data ?: return@withContext false
        if (!isExpectedCallback(uri)) return@withContext false
        requireSafeAuthConfiguration()
        if (!uri.fragment.isNullOrBlank()) {
            throw NativeAuthException("The sign-in callback used an unsupported token fragment. Request a new link.")
        }
        val pending = pendingOAuthRequest()
            ?: throw NativeAuthException("This sign-in link was not requested on this device.")
        if (pending.expiresAtMillis <= System.currentTimeMillis()) {
            sessionStore.clearPendingState()
            throw NativeAuthException("The sign-in request expired. Start again on this device.")
        }
        val returnedState = uri.getQueryParameter("state").orEmpty()
        if (!secureEquals(returnedState, pending.state)) {
            throw NativeAuthException("The sign-in link did not match this device request.")
        }
        val authCode = uri.getQueryParameter("code")?.takeIf { it.isNotBlank() && it.length <= 2_048 }
            ?: throw NativeAuthException("The sign-in link did not contain a usable authorization code.")
        val verifier = pending.verifier.takeIf { it.length in 43..128 && it.matches(PKCE_VERIFIER_PATTERN) }
            ?: throw NativeAuthException("The sign-in verifier is missing. Request a new link on this device.")
        val response = request(
            url = "$supabaseUrl/auth/v1/token?grant_type=pkce",
            method = "POST",
            body = JSONObject()
                .put("auth_code", authCode)
                .put("code_verifier", verifier)
                .toString(),
            headers = authHeaders()
        )
        if (response.code !in 200..299) {
            if (isRetryableStatus(response.code)) {
                throw NativeAuthTransientException("The sign-in exchange is temporarily unavailable. Try this link again.")
            }
            throw NativeAuthException("The sign-in link is invalid or expired. Request a new link.")
        }
        val session = parseSessionResponse(response.body)
        if (pending.flow == NativeOAuthFlow.LEGACY) {
            sessionStore.write(session)
            runCatching { sessionStore.clearPendingState() }
            return@withContext true
        }
        requireSafeTelegramConfiguration()
        if (pending.flow == NativeOAuthFlow.TELEGRAM_LINK
            && !pending.expectedUserId.equals(session.userId, ignoreCase = true)) {
            sessionStore.clearPendingState()
            throw NativeAuthException("Telegram returned a different account. The existing session was not replaced.")
        }
        sessionStore.write(session)
        val verifiedPending = pending.verifiedBy(session)
        sessionStore.setPendingOAuth(verifiedPending)
        finishTelegramFlow(session, verifiedPending)
        true
    }

    private fun isExpectedCallback(uri: Uri): Boolean {
        val expected = Uri.parse(authRedirectUri)
        return uri.scheme.equals(expected.scheme, ignoreCase = true)
            && uri.host.equals(expected.host, ignoreCase = true)
            && uri.port == expected.port
            && uri.path == expected.path
            && uri.userInfo == null
    }

    fun clearSession() {
        sessionStore.clear()
        sessionStore.clearPendingEmailOtp()
        sessionStore.clearPendingState()
    }

    suspend fun signOut() {
        val current = sessionStore.read()
        // Clear first so an in-flight worker stops before another authenticated
        // request. Room data and the outbox are deliberately untouched.
        sessionStore.clear()
        sessionStore.clearPendingEmailOtp()
        sessionStore.clearPendingState()
        if (current == null || !isAuthEnabled()) return
        requireSafeAuthConfiguration()
        val response = withContext(Dispatchers.IO) {
            request(
                url = "$supabaseUrl/auth/v1/logout?scope=local",
                method = "POST",
                body = null,
                headers = authHeaders(current.accessToken)
            )
        }
        if (response.code !in 200..299 && response.code !in setOf(401, 403, 404)) {
            throw NativeAuthException("Signed out on this device, but server sign-out could not be confirmed.")
        }
    }

    private fun newOAuthRequest(
        flow: NativeOAuthFlow,
        attemptToken: String? = null,
        expectedUserId: String? = null,
        expiresInMillis: Long = 10 * 60_000L
    ): PendingOAuthRequest {
        val now = System.currentTimeMillis()
        return PendingOAuthRequest(
            state = generateState(),
            verifier = generateCodeVerifier(),
            flow = flow,
            createdAtMillis = now,
            expiresAtMillis = now + expiresInMillis.coerceIn(1L, 15 * 60_000L),
            attemptToken = attemptToken,
            expectedUserId = expectedUserId
        )
    }

    private fun telegramAuthorizeUrl(pending: PendingOAuthRequest, linkIdentity: Boolean): Uri {
        val callback = Uri.parse(authRedirectUri).buildUpon()
            .appendQueryParameter("state", pending.state)
            .build()
            .toString()
        val path = if (linkIdentity) "/auth/v1/user/identities/authorize" else "/auth/v1/authorize"
        return Uri.parse("$supabaseUrl$path").buildUpon()
            .appendQueryParameter("provider", telegramProviderId)
            .appendQueryParameter("redirect_to", callback)
            .appendQueryParameter("scopes", TELEGRAM_SCOPES)
            .appendQueryParameter("code_challenge", codeChallenge(pending.verifier))
            .appendQueryParameter("code_challenge_method", "s256")
            .apply { if (linkIdentity) appendQueryParameter("skip_http_redirect", "true") }
            .build()
    }

    private fun pendingOAuthRequest(): PendingOAuthRequest? {
        sessionStore.getPendingOAuth()?.let { return it }
        val state = sessionStore.getPendingState() ?: return null
        val verifier = sessionStore.getPendingVerifier() ?: return null
        val now = System.currentTimeMillis()
        return PendingOAuthRequest(
            state = state,
            verifier = verifier,
            flow = NativeOAuthFlow.LEGACY,
            createdAtMillis = now,
            expiresAtMillis = now + 15 * 60_000L
        )
    }

    private fun abandonPendingAccountAuthentication() {
        val current = sessionStore.read()
        val emailAttempt = sessionStore.getPendingEmailOtp()
        val oauthAttempt = pendingOAuthRequest()
        if (current != null && (
                emailAttempt?.matchesVerifiedSession(current) == true
                    || (oauthAttempt?.flow in ACCOUNT_OAUTH_FLOWS
                        && oauthAttempt?.matchesVerifiedSession(current) == true)
            )) {
            clearSessionIfUnchanged(current)
        }
        sessionStore.clearPendingEmailOtp()
        sessionStore.clearPendingState()
    }

    private fun hasTelegramIdentity(session: NativeSession): Boolean {
        val response = request(
            url = "$supabaseUrl/auth/v1/user",
            method = "GET",
            body = null,
            headers = authHeaders(session.accessToken)
        )
        requireAuthenticatedApiResponse(response, session, "Telegram identities could not be verified.")
        val result = runCatching { JSONObject(response.body) }.getOrNull()
            ?: throw NativeAuthException("The authentication server returned invalid data.")
        if (!result.optString("id").equals(session.userId, ignoreCase = true)) {
            throw NativeAuthException("The authentication server returned a different account.")
        }
        val acceptedProviders = setOf(telegramProviderId, telegramProviderId.removePrefix("custom:"))
        val identities = result.optJSONArray("identities") ?: JSONArray()
        return (0 until identities.length()).any { index ->
            identities.optJSONObject(index)?.optString("provider") in acceptedProviders
        }
    }

    private fun finishTelegramFlow(session: NativeSession, pending: PendingOAuthRequest): NativeAccountProfile {
        if (!pending.matchesVerifiedSession(session)) {
            throw NativeAuthException("The Telegram flow did not match the encrypted session on this device.")
        }
        return try {
            when (pending.flow) {
                NativeOAuthFlow.TELEGRAM_ACTIVATION -> activateTelegramBeta(session, pending)
                NativeOAuthFlow.TELEGRAM_LINK -> {
                    if (!pending.expectedUserId.equals(session.userId, ignoreCase = true)) {
                        throw NativeAuthException("Telegram linking changed the signed-in account.")
                    }
                    activateTelegramLink(session)
                }
                NativeOAuthFlow.TELEGRAM_SIGN_IN -> Unit
                NativeOAuthFlow.LEGACY -> throw NativeAuthException("The legacy sign-in flow cannot be resumed.")
            }
            val profile = validateServerSession(session)
            sessionStore.clearPendingState()
            profile
        } catch (error: NativeAuthTransientException) {
            throw error
        } catch (error: Exception) {
            sessionStore.clearPendingState()
            if (pending.flow != NativeOAuthFlow.TELEGRAM_LINK) {
                clearSessionIfUnchanged(session)
            }
            throw error
        }
    }

    private fun activateTelegramBeta(session: NativeSession, pending: PendingOAuthRequest) {
        val attemptToken = pending.attemptToken?.takeIf { it.matches(OPAQUE_TOKEN_PATTERN) }
            ?: throw NativeAuthException("The Telegram beta attempt is missing.")
        val response = request(
            url = "$apiOrigin/api/v1/auth/telegram/activate",
            method = "POST",
            body = JSONObject().put("attemptToken", attemptToken).toString(),
            headers = authHeaders(session.accessToken)
        )
        requireAuthenticatedApiResponse(response, session, "Telegram beta activation was rejected.")
        val activated = runCatching { JSONObject(response.body).optBoolean("activated", false) }.getOrDefault(false)
        if (!activated) throw NativeAuthException("Telegram beta activation was rejected.")
    }

    private fun activateTelegramLink(session: NativeSession) {
        val response = request(
            url = "$apiOrigin/api/v1/account/telegram/link",
            method = "POST",
            body = null,
            headers = authHeaders(session.accessToken)
        )
        requireAuthenticatedApiResponse(response, session, "Telegram could not be linked to this account.")
        val linked = runCatching { JSONObject(response.body).optBoolean("linked", false) }.getOrDefault(false)
        if (!linked) throw NativeAuthException("Telegram could not be linked to this account.")
    }

    private fun validateServerSession(session: NativeSession): NativeAccountProfile {
        val response = request(
            url = "$apiOrigin/api/v1/session",
            method = "GET",
            body = null,
            headers = authHeaders(session.accessToken)
        )
        requireAuthenticatedApiResponse(response, session, "Account access could not be verified.")
        val result = runCatching { JSONObject(response.body) }.getOrNull()
            ?: throw NativeAuthException("The authentication server returned invalid data.")
        val user = result.optJSONObject("user")
            ?: throw NativeAuthException("The authentication server returned invalid account data.")
        val userId = user.optString("id")
        val role = user.optString("role")
        val assuranceLevel = result.optString("assuranceLevel")
        if (!userId.equals(session.userId, ignoreCase = true)
            || user.optString("status") != "active"
            || role !in setOf("owner", "beta")
            || assuranceLevel !in setOf("aal1", "aal2")) {
            throw NativeAuthException("The authentication server returned invalid account data.")
        }
        return NativeAccountProfile(
            userId = userId.lowercase(),
            email = user.optString("email"),
            role = role,
            assuranceLevel = assuranceLevel
        )
    }

    private fun requireAuthenticatedApiResponse(response: HttpResponse, session: NativeSession, message: String) {
        if (response.code in 200..299) return
        val errorCode = runCatching {
            JSONObject(response.body).optJSONObject("error")?.optString("code").orEmpty()
        }.getOrDefault("")
        if (response.code == 401 || (response.code == 403 && errorCode == "account_inactive")) {
            clearSessionIfUnchanged(session)
            throw NativeAuthException("The cloud session expired, was revoked, or is not approved.")
        }
        if (response.code == 403 && errorCode == "mfa_required") {
            throw NativeAuthException("Verify the owner session before using this action.")
        }
        if (isRetryableStatus(response.code)) {
            throw NativeAuthTransientException("Authentication is temporarily unavailable. Local commitments remain available.")
        }
        throw NativeAuthException(message)
    }

    private suspend fun refresh(refreshToken: String): NativeSession = withContext(Dispatchers.IO) {
        requireSafeAuthConfiguration()
        val response = request(
            url = "$supabaseUrl/auth/v1/token?grant_type=refresh_token",
            method = "POST",
            body = JSONObject().put("refresh_token", refreshToken).toString(),
            headers = authHeaders()
        )
        if (response.code !in 200..299) {
            if (!isRetryableStatus(response.code)) {
                sessionStore.clear()
                sessionStore.clearPendingEmailOtp()
            }
            if (isRetryableStatus(response.code)) {
                throw NativeAuthTransientException("Session refresh is temporarily unavailable. Local commitments are still available.")
            }
            throw NativeAuthException("Your cloud session expired. Local commitments are still available.")
        }
        val session = parseSessionResponse(response.body, refreshToken)
        sessionStore.write(session)
        session
    }

    internal open fun request(
        url: String,
        method: String,
        body: String?,
        headers: Map<String, String>
    ): HttpResponse {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 10_000
            readTimeout = 15_000
            useCaches = false
            instanceFollowRedirects = false
            doInput = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("Cache-Control", "no-store")
            headers.forEach { (key, value) -> setRequestProperty(key, value) }
        }
        return try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val responseBody = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { reader ->
                val content = StringBuilder()
                val buffer = CharArray(4_096)
                while (true) {
                    val count = reader.read(buffer)
                    if (count < 0) break
                    if (content.length + count > MAX_AUTH_RESPONSE_CHARS) {
                        throw NativeAuthException("The authentication response was too large.")
                    }
                    content.append(buffer, 0, count)
                }
                content.toString()
            }.orEmpty()
            HttpResponse(code, responseBody)
        } finally {
            connection.disconnect()
        }
    }

    internal data class HttpResponse(val code: Int, val body: String)

    private fun activateEmailOtp(session: NativeSession, attempt: PendingEmailOtpAttempt) {
        if (!attempt.matchesVerifiedSession(session)) {
            throw NativeAuthException("Enter the current email code before activating this session.")
        }
        requireUnchangedSession(session)
        val response = request(
            url = "$apiOrigin/api/v1/auth/email/activate",
            method = "POST",
            body = JSONObject().put("attemptToken", attempt.attemptToken).toString(),
            headers = mapOf("Authorization" to "Bearer ${session.accessToken}")
        )
        requireUnchangedSession(session)
        if (response.code in 200..299) {
            val activated = runCatching { JSONObject(response.body).optBoolean("activated", false) }.getOrDefault(false)
            if (!activated) {
                clearSessionIfUnchanged(session)
                sessionStore.clearPendingEmailOtp()
                throw NativeAuthException("The email-code request was not activated.")
            }
            sessionStore.clearPendingEmailOtp()
            return
        }
        if (isRetryableStatus(response.code)) {
            // Keep both encrypted pieces so a lost acknowledgement can be
            // retried idempotently after a restart without reusing the OTP.
            throw NativeAuthTransientException("Account activation is temporarily unavailable. Retry without requesting another code.")
        }
        clearSessionIfUnchanged(session)
        sessionStore.clearPendingEmailOtp()
        runCatching {
            request(
                url = "$supabaseUrl/auth/v1/logout?scope=local",
                method = "POST",
                body = null,
                headers = authHeaders(session.accessToken)
            )
        }
        throw NativeAuthException("The email-code request is invalid or expired.")
    }

    private data class TokenClaims(
        val issuer: String,
        val subject: String,
        val expiresAtSeconds: Long,
        val authenticatedAudience: Boolean,
        val assuranceLevel: String
    )

    private fun authHeaders(accessToken: String = supabasePublicKey): Map<String, String> = mapOf(
        "apikey" to supabasePublicKey,
        "Authorization" to "Bearer $accessToken"
    )

    private fun requireSafeAuthConfiguration() {
        val origin = runCatching { Uri.parse(supabaseUrl) }.getOrNull()
        if (!isAuthEnabled()
            || origin?.scheme != "https"
            || origin?.host.isNullOrBlank()
            || runCatching { Uri.parse(apiOrigin) }.getOrNull()?.scheme != "https"
            || runCatching { Uri.parse(apiOrigin) }.getOrNull()?.host.isNullOrBlank()
            || supabasePublicKey.isBlank()
            || authRedirectUri != NativeConfig.authRedirectUri
        ) {
            throw NativeAuthException("Authentication is not safely configured for this build.")
        }
    }

    private fun requireSafeTelegramConfiguration() {
        requireSafeAuthConfiguration()
        if (!telegramEnabled()
            || !telegramProviderId.matches(Regex("^custom:[a-z0-9:-]+$"))) {
            throw NativeAuthException("Telegram authentication is not safely configured for this build.")
        }
    }

    private fun parseSessionResponse(body: String, fallbackRefreshToken: String? = null): NativeSession {
        val json = runCatching { JSONObject(body) }
            .getOrElse { throw NativeAuthException("The authentication server returned invalid data.") }
        val accessToken = json.optString("access_token").takeIf(String::isNotBlank)
            ?: throw NativeAuthException("The authentication response did not contain an access token.")
        val refreshToken = json.optString("refresh_token").takeIf(String::isNotBlank)
            ?: fallbackRefreshToken?.takeIf(String::isNotBlank)
            ?: throw NativeAuthException("The authentication response did not contain a refresh token.")
        val expiresInValue = json.opt("expires_in")
        val expiresIn = (expiresInValue as? Number)?.toLong()
            ?.takeIf { it in 60L..86_400L }
            ?: throw NativeAuthException("The authentication response contained an invalid expiry.")
        val responseUserId = json.optJSONObject("user")?.optString("id")
            ?.takeIf { it.matches(UUID_PATTERN) }
            ?: throw NativeAuthException("The authentication response contained no stable account identity.")
        val claims = parseTokenClaims(accessToken)
            ?: throw NativeAuthException("The authentication response contained an invalid access token.")
        val expectedIssuer = "$supabaseUrl/auth/v1"
        val now = System.currentTimeMillis()
        val tokenExpiryMillis = runCatching { Math.multiplyExact(claims.expiresAtSeconds, 1_000L) }
            .getOrDefault(0L)
        if (claims.issuer != expectedIssuer
            || claims.subject != responseUserId
            || !claims.authenticatedAudience
            || tokenExpiryMillis <= now
        ) {
            throw NativeAuthException("The authentication response did not match this Supabase project and account.")
        }
        return NativeSession(
            accessToken = accessToken,
            refreshToken = refreshToken,
            expiresAtMillis = minOf(now + expiresIn * 1_000L, tokenExpiryMillis),
            userId = responseUserId,
            assuranceLevel = claims.assuranceLevel
        )
    }

    private fun parseTokenClaims(token: String): TokenClaims? = runCatching {
        val parts = token.split('.')
        if (parts.size != 3) return null
        val payloadJson = String(
            Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
            StandardCharsets.UTF_8
        )
        val payload = JSONObject(payloadJson)
        val audience = when (val value = payload.opt("aud")) {
            is String -> value == "authenticated"
            is JSONArray -> (0 until value.length()).any { value.optString(it) == "authenticated" }
            else -> false
        }
        TokenClaims(
            issuer = payload.optString("iss"),
            subject = payload.optString("sub"),
            expiresAtSeconds = (payload.opt("exp") as? Number)?.toLong() ?: 0L,
            authenticatedAudience = audience,
            assuranceLevel = if (payload.optString("aal") == "aal2") "aal2" else "aal1"
        )
    }.getOrNull()

    private fun requireMfaResponse(response: HttpResponse, expected: NativeSession, message: String) {
        if (response.code in 200..299) return
        if (response.code == 401 || response.code == 403) {
            clearSessionIfUnchanged(expected)
            throw NativeAuthException("The cloud session expired or was revoked. Local commitments remain available.")
        }
        if (isRetryableStatus(response.code)) {
            throw NativeAuthTransientException("Authentication is temporarily unavailable. Local commitments remain available.")
        }
        throw NativeAuthException(message)
    }

    private fun requireUnchangedSession(expected: NativeSession) {
        val current = sessionStore.read()
        if (current?.accessToken != expected.accessToken || current?.userId != expected.userId) {
            throw NativeAuthException("The signed-in account changed during verification. Try again with the current account.")
        }
    }

    private fun clearSessionIfUnchanged(expected: NativeSession) {
        val current = sessionStore.read()
        if (current?.accessToken == expected.accessToken && current?.userId == expected.userId) {
            sessionStore.clear()
        }
    }

    private fun secureEquals(left: String, right: String): Boolean = MessageDigest.isEqual(
        left.toByteArray(StandardCharsets.UTF_8),
        right.toByteArray(StandardCharsets.UTF_8)
    )

    private fun accessTokenHash(token: String): String = MessageDigest.getInstance("SHA-256")
        .digest(token.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private fun PendingEmailOtpAttempt.matchesVerifiedSession(session: NativeSession): Boolean =
        session.userId != null
            && verifiedUserId != null
            && secureEquals(verifiedUserId.lowercase(), session.userId.lowercase())
            && verifiedAccessTokenHash != null
            && secureEquals(verifiedAccessTokenHash, accessTokenHash(session.accessToken))

    internal fun codeChallenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(StandardCharsets.US_ASCII))
        return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private fun generateState(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private fun generateCodeVerifier(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private companion object {
        const val EXPIRY_SAFETY_WINDOW_MILLIS = 60_000L
        const val MAX_AUTH_RESPONSE_CHARS = 256 * 1024
        const val TELEGRAM_SCOPES = "openid profile telegram:bot_access"
        val PKCE_VERIFIER_PATTERN = Regex("^[A-Za-z0-9._~-]+$")
        val OPAQUE_TOKEN_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")
        val EMAIL_OTP_PATTERN = Regex("^[0-9]{6}$")
        val ACCOUNT_OAUTH_FLOWS = setOf(
            NativeOAuthFlow.TELEGRAM_SIGN_IN,
            NativeOAuthFlow.TELEGRAM_ACTIVATION
        )
        val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
        val RETRYABLE_STATUS = setOf(408, 425, 429)

        fun isRetryableStatus(code: Int): Boolean = code >= 500 || code in RETRYABLE_STATUS
    }
}
