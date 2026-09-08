package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class NativeAuthClientTest {
    private lateinit var store: SecureSessionStore
    private lateinit var client: NativeAuthClient

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        store = object : SecureSessionStore(context) {
            private var memSession: NativeSession? = null
            private var memState: String? = null
            private var memVerifier: String? = null
            private var memOAuth: PendingOAuthRequest? = null
            private var memEmailOtp: PendingEmailOtpAttempt? = null
            override fun read(): NativeSession? = memSession
            override fun write(session: NativeSession) { memSession = session }
            override fun clear() { memSession = null }
            override fun setPendingState(state: String, verifier: String) { memState = state; memVerifier = verifier }
            override fun setPendingOAuth(pending: PendingOAuthRequest) { memOAuth = pending }
            override fun getPendingOAuth(): PendingOAuthRequest? = memOAuth
            override fun getPendingState(): String? = memState
            override fun getPendingVerifier(): String? = memVerifier
            override fun clearPendingState() { memState = null; memVerifier = null; memOAuth = null }
            override fun setPendingEmailOtp(attempt: PendingEmailOtpAttempt) { memEmailOtp = attempt }
            override fun getPendingEmailOtp(): PendingEmailOtpAttempt? = memEmailOtp
            override fun clearPendingEmailOtp() { memEmailOtp = null }
        }
        client = testClient()
    }

    @After
    fun tearDown() {
        store.clear()
        store.clearPendingState()
        store.clearPendingEmailOtp()
    }

    @Test
    fun `callback rejects mismatched state before exchange`() = runBlocking {
        store.setPendingState("expected_state_123", VERIFIER)

        expectAuthFailure {
            client.acceptCallback(callbackIntent("code=auth-code&state=wrong_state_123"))
        }

        assertNull(store.read())
        assertEquals("expected_state_123", store.getPendingState())
    }

    @Test
    fun `callback rejects legacy implicit token fragments`() = runBlocking {
        store.setPendingState("state123", VERIFIER)

        expectAuthFailure {
            client.acceptCallback(Intent().apply {
                data = Uri.parse("tsurfing://auth/callback?state=state123#access_token=unsafe&refresh_token=unsafe")
            })
        }

        assertNull(store.read())
    }

    @Test
    fun `callback exchanges the code and stores only a project bound account`() = runBlocking {
        store.setPendingState("valid_state_123456", VERIFIER)
        var capturedUrl = ""
        var capturedBody = ""
        var capturedHeaders = emptyMap<String, String>()
        val exchangingClient = testClient { url, _, body, headers ->
            capturedUrl = url
            capturedBody = body.orEmpty()
            capturedHeaders = headers
            NativeAuthClient.HttpResponse(200, tokenResponse())
        }

        assertTrue(exchangingClient.acceptCallback(callbackIntent("code=one-time-code&state=valid_state_123456")))

        val exchange = JSONObject(capturedBody)
        assertTrue(capturedUrl.endsWith("/auth/v1/token?grant_type=pkce"))
        assertEquals("one-time-code", exchange.getString("auth_code"))
        assertEquals(VERIFIER, exchange.getString("code_verifier"))
        assertEquals(PUBLIC_KEY, capturedHeaders["apikey"])
        assertEquals("Bearer $PUBLIC_KEY", capturedHeaders["Authorization"])
        assertEquals(USER_ID, store.read()?.userId)
        assertNull(store.getPendingState())
        assertNull(store.getPendingVerifier())
    }

    @Test
    fun `Telegram sign in builds the Supabase PKCE URL without legacy widget parameters`() = runBlocking {
        val authorizeUrl = client.beginTelegramSignIn()
        val pending = store.getPendingOAuth()

        assertNotNull(pending)
        assertEquals(NativeOAuthFlow.TELEGRAM_SIGN_IN, pending?.flow)
        assertEquals("$SUPABASE_URL/auth/v1/authorize", authorizeUrl.buildUpon().clearQuery().build().toString())
        assertEquals("custom:telegram", authorizeUrl.getQueryParameter("provider"))
        assertEquals("openid profile telegram:bot_access", authorizeUrl.getQueryParameter("scopes"))
        assertNull(authorizeUrl.getQueryParameter("origin"))
        assertEquals("s256", authorizeUrl.getQueryParameter("code_challenge_method"))
        assertEquals(client.codeChallenge(pending!!.verifier), authorizeUrl.getQueryParameter("code_challenge"))
        val callback = Uri.parse(authorizeUrl.getQueryParameter("redirect_to"))
        assertEquals(AUTH_REDIRECT, callback.buildUpon().clearQuery().build().toString())
        assertEquals(pending.state, callback.getQueryParameter("state"))
        assertNull(authorizeUrl.getQueryParameter("queryParams"))
        assertNull(authorizeUrl.getQueryParameter("state"))
        assertNull(authorizeUrl.getQueryParameter("bot_id"))
    }

    @Test
    fun `Telegram activation preflight sends no OAuth state and stores only opaque invite authority`() = runBlocking {
        var preflightBody = JSONObject()
        val activationClient = testClient { url, method, body, headers ->
            assertEquals("$API_ORIGIN/api/v1/auth/telegram/preflight", url)
            assertEquals("POST", method)
            assertTrue(headers.isEmpty())
            preflightBody = JSONObject(body!!)
            NativeAuthClient.HttpResponse(200, JSONObject()
                .put("attemptToken", ATTEMPT_TOKEN)
                .put("provider", "custom:telegram")
                .put("expiresInSeconds", 600)
                .toString())
        }

        val authorizeUrl = activationClient.beginTelegramActivation("invite-secret", "captcha-proof")
        val pending = store.getPendingOAuth()

        assertEquals(setOf("code", "captchaToken"), preflightBody.keys().asSequence().toSet())
        assertEquals("invite-secret", preflightBody.getString("code"))
        assertEquals("captcha-proof", preflightBody.getString("captchaToken"))
        assertEquals(NativeOAuthFlow.TELEGRAM_ACTIVATION, pending?.flow)
        assertEquals(ATTEMPT_TOKEN, pending?.attemptToken)
        assertEquals("custom:telegram", authorizeUrl.getQueryParameter("provider"))
    }

    @Test
    fun `Telegram activation exchanges once then activates and validates before exposing session`() = runBlocking {
        val pending = telegramPending(NativeOAuthFlow.TELEGRAM_ACTIVATION, attemptToken = ATTEMPT_TOKEN)
        store.setPendingOAuth(pending)
        val paths = mutableListOf<String>()
        val activationClient = testClient { url, _, body, headers ->
            paths += Uri.parse(url).path.orEmpty()
            when {
                url.contains("/auth/v1/token") -> NativeAuthClient.HttpResponse(200, tokenResponse())
                url.endsWith("/api/v1/auth/telegram/activate") -> {
                    assertEquals(ATTEMPT_TOKEN, JSONObject(body!!).getString("attemptToken"))
                    assertEquals("Bearer ${jwt()}", headers["Authorization"])
                    NativeAuthClient.HttpResponse(200, "{\"activated\":true}")
                }
                url.endsWith("/api/v1/session") -> NativeAuthClient.HttpResponse(200, activeProfileResponse())
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        assertTrue(activationClient.acceptCallback(callbackIntent("code=telegram-code&state=${pending.state}")))

        assertEquals(listOf("/auth/v1/token", "/api/v1/auth/telegram/activate", "/api/v1/session"), paths)
        assertNotNull(store.read())
        assertNull(store.getPendingOAuth())
        assertNotNull(activationClient.currentSession())
    }

    @Test
    fun `lost Telegram activation acknowledgement retries without exchanging the code twice`() = runBlocking {
        val pending = telegramPending(NativeOAuthFlow.TELEGRAM_ACTIVATION, attemptToken = ATTEMPT_TOKEN)
        store.setPendingOAuth(pending)
        var exchanges = 0
        var activations = 0
        val activationClient = testClient { url, _, _, _ ->
            when {
                url.contains("/auth/v1/token") -> {
                    exchanges += 1
                    NativeAuthClient.HttpResponse(200, tokenResponse())
                }
                url.endsWith("/api/v1/auth/telegram/activate") -> {
                    activations += 1
                    NativeAuthClient.HttpResponse(
                        if (activations == 1) 503 else 200,
                        if (activations == 1) "{}" else "{\"activated\":true}"
                    )
                }
                url.endsWith("/api/v1/session") -> NativeAuthClient.HttpResponse(200, activeProfileResponse())
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        expectTransientAuthFailure {
            activationClient.acceptCallback(callbackIntent("code=telegram-code&state=${pending.state}"))
        }
        assertNotNull(store.read())
        assertNotNull(store.getPendingOAuth()?.verifiedAccessTokenHash)
        assertNull(activationClient.currentSession())

        val profile = activationClient.resumePendingTelegramFlow()
        assertEquals(USER_ID, profile?.userId)
        assertEquals(1, exchanges)
        assertEquals(2, activations)
        assertNull(store.getPendingOAuth())
    }

    @Test
    fun `unapproved Telegram sign in clears the exchanged session and pending flow`() = runBlocking {
        val pending = telegramPending(NativeOAuthFlow.TELEGRAM_SIGN_IN)
        store.setPendingOAuth(pending)
        val signInClient = testClient { url, _, _, _ ->
            when {
                url.contains("/auth/v1/token") -> NativeAuthClient.HttpResponse(200, tokenResponse())
                url.endsWith("/api/v1/session") -> NativeAuthClient.HttpResponse(403, "{}")
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        expectAuthFailure {
            signInClient.acceptCallback(callbackIntent("code=telegram-code&state=${pending.state}"))
        }

        assertNull(store.read())
        assertNull(store.getPendingOAuth())
    }

    @Test
    fun `Telegram link uses the authenticated Supabase identity endpoint and binds the current UUID`() = runBlocking {
        val current = session()
        store.write(current)
        var identityAuthorizeUrl: Uri? = null
        val linkClient = testClient { url, _, _, headers ->
            when {
                url.endsWith("/api/v1/session") -> NativeAuthClient.HttpResponse(200, activeProfileResponse())
                url.endsWith("/auth/v1/user") -> NativeAuthClient.HttpResponse(
                    200,
                    JSONObject().put("id", USER_ID).put("identities", org.json.JSONArray()).toString()
                )
                url.contains("/auth/v1/user/identities/authorize") -> {
                    assertEquals("Bearer access-token", headers["Authorization"])
                    identityAuthorizeUrl = Uri.parse(url)
                    NativeAuthClient.HttpResponse(200, "{\"url\":\"https://oauth.telegram.org/auth?state=provider-owned\"}")
                }
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        val providerUrl = linkClient.beginTelegramLink()
        val pending = store.getPendingOAuth()

        assertEquals("oauth.telegram.org", providerUrl?.host)
        assertEquals(NativeOAuthFlow.TELEGRAM_LINK, pending?.flow)
        assertEquals(USER_ID, pending?.expectedUserId)
        assertEquals("true", identityAuthorizeUrl?.getQueryParameter("skip_http_redirect"))
        assertEquals("s256", identityAuthorizeUrl?.getQueryParameter("code_challenge_method"))
        assertEquals("custom:telegram", identityAuthorizeUrl?.getQueryParameter("provider"))
        assertNull(identityAuthorizeUrl?.getQueryParameter("origin"))
        assertNull(identityAuthorizeUrl?.getQueryParameter("bot_id"))
    }

    @Test
    fun `Telegram link callback never replaces the current account with a different UUID`() = runBlocking {
        val original = session()
        store.write(original)
        val pending = telegramPending(NativeOAuthFlow.TELEGRAM_LINK, expectedUserId = USER_ID)
        store.setPendingOAuth(pending)
        val otherUser = "00000000-0000-4000-8000-000000000099"
        val linkClient = testClient { url, _, _, _ ->
            if (!url.contains("/auth/v1/token")) throw AssertionError("Unexpected request: $url")
            NativeAuthClient.HttpResponse(200, tokenResponse(accessToken = jwt(sub = otherUser), userId = otherUser))
        }

        expectAuthFailure {
            linkClient.acceptCallback(callbackIntent("code=link-code&state=${pending.state}"))
        }

        assertEquals(original, store.read())
        assertNull(store.getPendingOAuth())
    }

    @Test
    fun `Telegram link collision preserves the current signed in account`() = runBlocking {
        val current = session(accessToken = jwt())
        store.write(current)
        val pending = telegramPending(NativeOAuthFlow.TELEGRAM_LINK, expectedUserId = USER_ID)
        store.setPendingOAuth(pending)
        val linkClient = testClient { url, _, _, _ ->
            when {
                url.contains("/auth/v1/token") -> NativeAuthClient.HttpResponse(200, tokenResponse())
                url.endsWith("/api/v1/account/telegram/link") -> NativeAuthClient.HttpResponse(
                    409,
                    "{\"error\":{\"code\":\"telegram_identity_in_use\"}}"
                )
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        expectAuthFailure {
            linkClient.acceptCallback(callbackIntent("code=link-code&state=${pending.state}"))
        }

        assertEquals(USER_ID, store.read()?.userId)
        assertNull(store.getPendingOAuth())
    }

    @Test
    fun `owner MFA requirement does not erase a valid AAL1 session`() = runBlocking {
        val current = session(accessToken = jwt())
        store.write(current)
        val statusClient = testClient { url, _, _, _ ->
            assertTrue(url.endsWith("/api/v1/account/telegram"))
            NativeAuthClient.HttpResponse(403, "{\"error\":{\"code\":\"mfa_required\"}}")
        }

        expectAuthFailure { statusClient.telegramStatus() }

        assertEquals(current, store.read())
    }

    @Test
    fun `expired exchanged token is rejected without writing a session`() = runBlocking {
        store.setPendingState("state123", VERIFIER)
        val exchangingClient = testClient { _, _, _, _ ->
            NativeAuthClient.HttpResponse(
                200,
                tokenResponse(accessToken = jwt(exp = System.currentTimeMillis() / 1_000L - 60L))
            )
        }

        expectAuthFailure {
            exchangingClient.acceptCallback(callbackIntent("code=expired-code&state=state123"))
        }

        assertNull(store.read())
        assertEquals(VERIFIER, store.getPendingVerifier())
    }

    @Test
    fun `exchange account mismatch is rejected without writing a session`() = runBlocking {
        store.setPendingState("state123", VERIFIER)
        val exchangingClient = testClient { _, _, _, _ ->
            NativeAuthClient.HttpResponse(
                200,
                tokenResponse(userId = "00000000-0000-4000-8000-000000000099")
            )
        }

        expectAuthFailure {
            exchangingClient.acceptCallback(callbackIntent("code=mismatch-code&state=state123"))
        }

        assertNull(store.read())
    }

    @Test
    fun `exchange rejects a token issued by another Supabase project`() = runBlocking {
        store.setPendingState("state123", VERIFIER)
        val exchangingClient = testClient { _, _, _, _ ->
            NativeAuthClient.HttpResponse(
                200,
                tokenResponse(accessToken = jwt(iss = "https://other-project.supabase.co/auth/v1"))
            )
        }

        expectAuthFailure {
            exchangingClient.acceptCallback(callbackIntent("code=wrong-project&state=state123"))
        }

        assertNull(store.read())
    }

    @Test
    fun `exchange rejects a token without the authenticated audience`() = runBlocking {
        store.setPendingState("state123", VERIFIER)
        val exchangingClient = testClient { _, _, _, _ ->
            NativeAuthClient.HttpResponse(200, tokenResponse(accessToken = jwt(aud = "anon")))
        }

        expectAuthFailure {
            exchangingClient.acceptCallback(callbackIntent("code=wrong-audience&state=state123"))
        }

        assertNull(store.read())
    }

    @Test
    fun `email verification policy accepts only explicit server booleans`(): Unit = runBlocking {
        for (required in listOf(true, false)) {
            val policyClient = testClient { url, method, body, headers ->
                assertEquals("$API_ORIGIN/api/v1/auth/email/config", url)
                assertEquals("GET", method)
                assertNull(body)
                assertTrue(headers.isEmpty())
                NativeAuthClient.HttpResponse(200, "{\"captchaRequired\":$required}")
            }
            assertEquals(required, policyClient.emailCaptchaRequired())
        }
        for (body in listOf("{}", "{\"captchaRequired\":\"false\"}", "{\"captchaRequired\":null}", "invalid")) {
            val invalidClient = testClient { _, _, _, _ -> NativeAuthClient.HttpResponse(200, body) }
            expectAuthFailure { invalidClient.emailCaptchaRequired() }
        }
        val unavailable = testClient { _, _, _, _ -> NativeAuthClient.HttpResponse(404, "{}") }
        expectAuthFailure { unavailable.emailCaptchaRequired() }
    }

    @Test
    fun `email code request uses server preflight and retains only opaque activation authority`() = runBlocking {
        var capturedUrl = ""
        var capturedBody = ""
        val capturingClient = testClient { url, method, body, headers ->
            capturedUrl = url
            capturedBody = body.orEmpty()
            assertEquals("POST", method)
            assertTrue(headers.isEmpty())
            NativeAuthClient.HttpResponse(202, JSONObject()
                .put("accepted", true)
                .put("attemptToken", ATTEMPT_TOKEN)
                .put("expiresInSeconds", 600)
                .put("resendAfterSeconds", 60)
                .toString())
        }

        val attempt = capturingClient.requestEmailCode(
            email = " Person@Example.com ",
            purpose = "activation",
            inviteCode = "invite-secret",
            captchaToken = "captcha-proof"
        )

        val body = JSONObject(capturedBody)
        assertEquals("$API_ORIGIN/api/v1/auth/email/preflight", capturedUrl)
        assertEquals("person@example.com", body.getString("email"))
        assertEquals("activation", body.getString("purpose"))
        assertEquals("invite-secret", body.getString("code"))
        assertEquals("captcha-proof", body.getString("captchaToken"))
        assertEquals(ATTEMPT_TOKEN, attempt.attemptToken)
        assertEquals(attempt, store.getPendingEmailOtp())
        assertNull(store.getPendingState())
    }

    @Test
    fun `typed email code verifies through Supabase then activates before exposing session`() = runBlocking {
        store.setPendingEmailOtp(PendingEmailOtpAttempt(
            ATTEMPT_TOKEN,
            "person@example.com",
            "sign_in",
            System.currentTimeMillis() + 600_000L,
            System.currentTimeMillis() + 60_000L
        ))
        val requests = mutableListOf<Pair<String, String?>>()
        val verifyingClient = testClient { url, _, body, headers ->
            requests += url to body
            when {
                url.endsWith("/auth/v1/verify") -> {
                    assertEquals(PUBLIC_KEY, headers["apikey"])
                    val verification = JSONObject(body!!)
                    assertEquals("person@example.com", verification.getString("email"))
                    assertEquals("123456", verification.getString("token"))
                    assertEquals("email", verification.getString("type"))
                    NativeAuthClient.HttpResponse(200, tokenResponse())
                }
                url.endsWith("/api/v1/auth/email/activate") -> {
                    assertEquals("Bearer ${jwt()}", headers["Authorization"])
                    assertEquals(ATTEMPT_TOKEN, JSONObject(body!!).getString("attemptToken"))
                    NativeAuthClient.HttpResponse(200, "{\"activated\":true}")
                }
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        val session = verifyingClient.verifyEmailCode("person@example.com", "123456")

        assertEquals(USER_ID, session.userId)
        assertEquals(session, store.read())
        assertNull(store.getPendingEmailOtp())
        assertEquals(2, requests.size)
    }

    @Test
    fun `transient activation failure retains encrypted session and one-use attempt for retry`() = runBlocking {
        val attempt = PendingEmailOtpAttempt(
            ATTEMPT_TOKEN,
            "person@example.com",
            "sign_in",
            System.currentTimeMillis() + 600_000L,
            System.currentTimeMillis() + 60_000L
        )
        store.setPendingEmailOtp(attempt)
        var verifyCount = 0
        var activationCount = 0
        val verifyingClient = testClient { url, _, _, _ ->
            when {
                url.endsWith("/auth/v1/verify") -> {
                    verifyCount += 1
                    NativeAuthClient.HttpResponse(200, tokenResponse())
                }
                url.endsWith("/api/v1/auth/email/activate") -> {
                    activationCount += 1
                    NativeAuthClient.HttpResponse(
                        if (activationCount == 1) 503 else 200,
                        if (activationCount == 1) "{}" else "{\"activated\":true}"
                    )
                }
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        expectTransientAuthFailure { verifyingClient.verifyEmailCode("person@example.com", "123456") }

        assertNotNull(store.read())
        val retained = store.getPendingEmailOtp()
        assertEquals(attempt.attemptToken, retained?.attemptToken)
        assertEquals(USER_ID, retained?.verifiedUserId)
        assertNotNull(retained?.verifiedAccessTokenHash)
        assertEquals(store.read(), verifyingClient.resumePendingEmailActivation())
        assertEquals(1, verifyCount)
        assertEquals(2, activationCount)
        assertNull(store.getPendingEmailOtp())
    }

    @Test
    fun `pre-existing session never bypasses typed email code verification`() = runBlocking {
        store.setPendingEmailOtp(PendingEmailOtpAttempt(
            ATTEMPT_TOKEN,
            "person@example.com",
            "activation",
            System.currentTimeMillis() + 600_000L,
            System.currentTimeMillis() + 60_000L
        ))
        store.write(session(accessToken = "pre-existing-session"))
        val requestedPaths = mutableListOf<String>()
        val verifyingClient = testClient { url, _, _, _ ->
            requestedPaths += url
            when {
                url.endsWith("/auth/v1/verify") -> NativeAuthClient.HttpResponse(200, tokenResponse())
                url.endsWith("/api/v1/auth/email/activate") -> NativeAuthClient.HttpResponse(200, "{\"activated\":true}")
                else -> throw AssertionError("Unexpected request: $url")
            }
        }

        verifyingClient.verifyEmailCode("person@example.com", "123456")

        assertEquals(2, requestedPaths.size)
        assertTrue(requestedPaths[0].endsWith("/auth/v1/verify"))
        assertTrue(requestedPaths[1].endsWith("/api/v1/auth/email/activate"))
    }

    @Test
    fun `code challenge matches the RFC7636 S256 vector`() {
        val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", client.codeChallenge(verifier))
    }

    @Test
    fun `owner authenticator challenge stores an exact aal2 session`() = runBlocking {
        store.write(session())
        val requests = mutableListOf<Pair<String, String?>>()
        val mfaClient = testClient { url, method, body, headers ->
            assertEquals("Bearer access-token", headers["Authorization"])
            requests += ("$method $url" to body)
            when {
                url.endsWith("/auth/v1/user") -> NativeAuthClient.HttpResponse(
                    200,
                    JSONObject().put("factors", org.json.JSONArray().put(JSONObject()
                        .put("id", FACTOR_ID)
                        .put("factor_type", "totp")
                        .put("status", "verified"))).toString()
                )
                url.endsWith("/factors/$FACTOR_ID/challenge") -> NativeAuthClient.HttpResponse(
                    200,
                    JSONObject().put("id", CHALLENGE_ID).put("type", "totp").toString()
                )
                url.endsWith("/factors/$FACTOR_ID/verify") -> NativeAuthClient.HttpResponse(
                    200,
                    tokenResponse(accessToken = jwt(aal = "aal2"))
                )
                else -> throw AssertionError("Unexpected MFA request: $url")
            }
        }

        val elevated = mfaClient.completeMfa("123456")

        assertEquals("aal2", elevated.assuranceLevel)
        assertEquals(USER_ID, elevated.userId)
        assertEquals(elevated, store.read())
        assertEquals(3, requests.size)
        assertEquals(FACTOR_ID, JSONObject(requests[1].second!!).getString("factorId"))
        val verification = JSONObject(requests[2].second!!)
        assertEquals(CHALLENGE_ID, verification.getString("challenge_id"))
        assertEquals("123456", verification.getString("code"))
    }

    @Test
    fun `invalid authenticator code is rejected before network and retains session`() = runBlocking {
        val original = session()
        store.write(original)
        val mfaClient = testClient { _, _, _, _ ->
            throw AssertionError("Network request was not expected")
        }

        expectAuthFailure { mfaClient.completeMfa("12 34") }

        assertEquals(original, store.read())
    }

    @Test
    fun `mfa verification never overwrites a session changed during challenge`() = runBlocking {
        val original = session()
        val replacement = session(
            accessToken = "replacement-token",
            userId = "00000000-0000-4000-8000-000000000099"
        )
        store.write(original)
        var requestCount = 0
        val mfaClient = testClient { url, _, _, _ ->
            requestCount += 1
            if (!url.endsWith("/auth/v1/user")) throw AssertionError("Only the factor lookup was expected")
            store.write(replacement)
            NativeAuthClient.HttpResponse(
                200,
                JSONObject().put("factors", org.json.JSONArray().put(JSONObject()
                    .put("id", FACTOR_ID)
                    .put("factor_type", "totp")
                    .put("status", "verified"))).toString()
            )
        }

        expectAuthFailure { mfaClient.completeMfa("123456") }

        assertEquals(1, requestCount)
        assertEquals(replacement, store.read())
    }

    @Test
    fun `revoked mfa session clears only the matching cloud session`() = runBlocking {
        store.write(session())
        val mfaClient = testClient { _, _, _, _ -> NativeAuthClient.HttpResponse(401, "{}") }

        expectAuthFailure { mfaClient.completeMfa("123456") }

        assertNull(store.read())
    }

    @Test
    fun `temporary refresh failure retains the durable session`() = runBlocking {
        val original = session(expiresAtMillis = System.currentTimeMillis() + 30_000L)
        store.write(original)
        val refreshingClient = testClient { _, _, _, _ -> NativeAuthClient.HttpResponse(503, "{}") }

        expectTransientAuthFailure { refreshingClient.currentSession() }

        assertEquals(original, store.read())
    }

    @Test
    fun `permanent refresh rejection clears tokens but not local data`() = runBlocking {
        store.write(session(expiresAtMillis = System.currentTimeMillis() + 30_000L))
        val refreshingClient = testClient { _, _, _, _ -> NativeAuthClient.HttpResponse(400, "{}") }

        expectAuthFailure { refreshingClient.currentSession() }

        assertNull(store.read())
    }

    @Test
    fun `sign out clears locally then revokes only the current Supabase session`() = runBlocking {
        store.write(session())
        var capturedUrl = ""
        var capturedHeaders = emptyMap<String, String>()
        val signingOutClient = testClient { url, _, _, headers ->
            capturedUrl = url
            capturedHeaders = headers
            assertNull(store.read())
            NativeAuthClient.HttpResponse(204, "")
        }

        signingOutClient.signOut()

        assertTrue(capturedUrl.endsWith("/auth/v1/logout?scope=local"))
        assertEquals("Bearer access-token", capturedHeaders["Authorization"])
        assertNull(store.read())
    }

    @Test
    fun `unconfirmed server sign out remains visible while local session stays cleared`() = runBlocking {
        store.write(session())
        val signingOutClient = testClient { _, _, _, _ -> NativeAuthClient.HttpResponse(503, "{}") }

        expectAuthFailure { signingOutClient.signOut() }

        assertNull(store.read())
    }

    private fun testClient(
        responder: ((String, String, String?, Map<String, String>) -> NativeAuthClient.HttpResponse)? = null
    ): NativeAuthClient = object : NativeAuthClient(
        sessionStore = store,
        isAuthEnabled = { true },
        supabaseUrl = SUPABASE_URL,
        supabasePublicKey = PUBLIC_KEY,
        apiOrigin = API_ORIGIN,
        authRedirectUri = AUTH_REDIRECT,
        telegramEnabled = { true },
        telegramProviderId = "custom:telegram"
    ) {
        override fun request(url: String, method: String, body: String?, headers: Map<String, String>): HttpResponse {
            return responder?.invoke(url, method, body, headers)
                ?: throw AssertionError("Network request was not expected: $url")
        }
    }

    private fun callbackIntent(query: String): Intent = Intent().apply {
        data = Uri.parse("$AUTH_REDIRECT?$query")
    }

    private fun telegramPending(
        flow: NativeOAuthFlow,
        attemptToken: String? = null,
        expectedUserId: String? = null
    ): PendingOAuthRequest = PendingOAuthRequest(
        state = "telegram_state_1234567890",
        verifier = VERIFIER,
        flow = flow,
        createdAtMillis = System.currentTimeMillis(),
        expiresAtMillis = System.currentTimeMillis() + 600_000L,
        attemptToken = attemptToken,
        expectedUserId = expectedUserId
    )

    private fun activeProfileResponse(
        userId: String = USER_ID,
        role: String = "beta",
        assuranceLevel: String = "aal1"
    ): String = JSONObject()
        .put("user", JSONObject()
            .put("id", userId)
            .put("email", "person@example.com")
            .put("role", role)
            .put("status", "active"))
        .put("assuranceLevel", assuranceLevel)
        .toString()

    private fun session(
        expiresAtMillis: Long = System.currentTimeMillis() + 3_600_000L,
        accessToken: String = "access-token",
        userId: String = USER_ID,
        assuranceLevel: String = "aal1"
    ) = NativeSession(
        accessToken = accessToken,
        refreshToken = "refresh-token",
        expiresAtMillis = expiresAtMillis,
        userId = userId,
        assuranceLevel = assuranceLevel
    )

    private fun tokenResponse(
        accessToken: String = jwt(),
        userId: String = USER_ID
    ): String = JSONObject()
        .put("access_token", accessToken)
        .put("refresh_token", "refresh-token")
        .put("expires_in", 3_600)
        .put("user", JSONObject().put("id", userId))
        .toString()

    private fun jwt(
        iss: String = "$SUPABASE_URL/auth/v1",
        aud: String = "authenticated",
        exp: Long = System.currentTimeMillis() / 1_000L + 3_600L,
        sub: String = USER_ID,
        aal: String = "aal1"
    ): String {
        val header = Base64.getUrlEncoder().withoutPadding()
            .encodeToString("""{"alg":"RS256","typ":"JWT"}""".toByteArray())
        val payload = JSONObject()
            .put("iss", iss)
            .put("aud", aud)
            .put("exp", exp)
            .put("sub", sub)
            .put("aal", aal)
        val encodedPayload = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(payload.toString().toByteArray())
        return "$header.$encodedPayload.synthetic-signature"
    }

    private suspend fun expectAuthFailure(block: suspend () -> Unit): NativeAuthException {
        return try {
            block()
            throw AssertionError("Expected NativeAuthException")
        } catch (error: NativeAuthException) {
            error
        }
    }

    private suspend fun expectTransientAuthFailure(block: suspend () -> Unit): NativeAuthTransientException {
        return try {
            block()
            throw AssertionError("Expected NativeAuthTransientException")
        } catch (error: NativeAuthTransientException) {
            error
        }
    }

    private companion object {
        const val SUPABASE_URL = "https://project-ref.supabase.co"
        const val API_ORIGIN = "https://app.tsurfing.com"
        const val PUBLIC_KEY = "sb_publishable_goalflow_test"
        const val AUTH_REDIRECT = "tsurfing://auth/callback"
        const val USER_ID = "00000000-0000-4000-8000-000000000001"
        const val FACTOR_ID = "00000000-0000-4000-8000-000000000002"
        const val CHALLENGE_ID = "00000000-0000-4000-8000-000000000003"
        const val VERIFIER = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"
        const val ATTEMPT_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    }
}
