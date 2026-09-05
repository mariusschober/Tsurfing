package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.AEADBadTagException
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class NativeSession(
    val accessToken: String,
    val refreshToken: String,
    val expiresAtMillis: Long,
    val userId: String?,
    val assuranceLevel: String = "aal1"
)

data class PendingEmailOtpAttempt(
    val attemptToken: String,
    val email: String,
    val purpose: String,
    val expiresAtMillis: Long,
    val resendAtMillis: Long,
    val verifiedUserId: String? = null,
    val verifiedAccessTokenHash: String? = null
)

enum class NativeOAuthFlow(val storageValue: String) {
    LEGACY("legacy"),
    TELEGRAM_SIGN_IN("telegram_sign_in"),
    TELEGRAM_ACTIVATION("telegram_activation"),
    TELEGRAM_LINK("telegram_link");

    companion object {
        fun fromStorage(value: String): NativeOAuthFlow? = entries.firstOrNull { it.storageValue == value }
    }
}

data class PendingOAuthRequest(
    val state: String,
    val verifier: String,
    val flow: NativeOAuthFlow,
    val createdAtMillis: Long,
    val expiresAtMillis: Long,
    val attemptToken: String? = null,
    val expectedUserId: String? = null,
    val verifiedUserId: String? = null,
    val verifiedAccessTokenHash: String? = null
) {
    fun matchesVerifiedSession(session: NativeSession): Boolean =
        verifiedUserId != null
            && verifiedAccessTokenHash != null
            && verifiedUserId.equals(session.userId, ignoreCase = true)
            && verifiedAccessTokenHash == session.accessToken.toByteArray(StandardCharsets.UTF_8)
                .let { MessageDigest.getInstance("SHA-256").digest(it) }
                .joinToString("") { "%02x".format(it) }

    fun verifiedBy(session: NativeSession): PendingOAuthRequest = copy(
        verifiedUserId = session.userId,
        verifiedAccessTokenHash = session.accessToken.toByteArray(StandardCharsets.UTF_8)
            .let { MessageDigest.getInstance("SHA-256").digest(it) }
            .joinToString("") { "%02x".format(it) }
    )
}

fun interface NativeSessionProvider {
    fun read(): NativeSession?
}

/** Stores cloud session material encrypted by an Android Keystore key. */
open class SecureSessionStore(context: Context) : NativeSessionProvider {
    private val preferences = context.getSharedPreferences("goalflow-secure-session", Context.MODE_PRIVATE)
    @Volatile private var inMemoryReadProblem: String? = null

    override fun read(): NativeSession? {
        return try {
            val encoded = preferences.getString(KEY_SESSION, null) ?: return null
            val json = JSONObject(decrypt(encoded))
            NativeSession(
                accessToken = json.getString("accessToken"),
                refreshToken = json.getString("refreshToken"),
                expiresAtMillis = json.getLong("expiresAtMillis"),
                userId = if (!json.has("userId") || json.isNull("userId")) null
                    else json.optString("userId").takeIf(String::isNotBlank),
                assuranceLevel = if (json.optString("assuranceLevel") == "aal2") "aal2" else "aal1"
            ).also { clearReadProblemAfterVerifiedRead() }
        } catch (error: Exception) {
            recordReadProblem(error)
            null
        }
    }

    open fun readProblem(): String? = inMemoryReadProblem
        ?: runCatching { preferences.getString(KEY_SESSION_READ_PROBLEM, null) }.getOrNull()

    open fun write(session: NativeSession) {
        val json = JSONObject().apply {
            put("accessToken", session.accessToken)
            put("refreshToken", session.refreshToken)
            put("expiresAtMillis", session.expiresAtMillis)
            put("userId", session.userId ?: JSONObject.NULL)
            put("assuranceLevel", if (session.assuranceLevel == "aal2") "aal2" else "aal1")
        }
        check(preferences.edit()
            .putString(KEY_SESSION, encrypt(json.toString()))
            .remove(KEY_SESSION_READ_PROBLEM)
            .commit()) {
            "The cloud session could not be stored durably."
        }
        inMemoryReadProblem = null
    }

    open fun clear() {
        check(preferences.edit().remove(KEY_SESSION).remove(KEY_SESSION_READ_PROBLEM).commit()) {
            "The cloud session could not be cleared."
        }
        inMemoryReadProblem = null
    }

    open fun setPendingOAuth(pending: PendingOAuthRequest) {
        require(validPendingOAuth(pending)) { "The pending auth request was invalid." }
        val encrypted = encrypt(JSONObject().apply {
            put("state", pending.state)
            put("verifier", pending.verifier)
            put("flow", pending.flow.storageValue)
            put("createdAtMillis", pending.createdAtMillis)
            put("expiresAtMillis", pending.expiresAtMillis)
            put("attemptToken", pending.attemptToken ?: JSONObject.NULL)
            put("expectedUserId", pending.expectedUserId ?: JSONObject.NULL)
            put("verifiedUserId", pending.verifiedUserId ?: JSONObject.NULL)
            put("verifiedAccessTokenHash", pending.verifiedAccessTokenHash ?: JSONObject.NULL)
        }.toString())
        check(preferences.edit()
            .putString(KEY_PENDING_AUTH, encrypted)
            .remove(KEY_PENDING_STATE)
            .remove(KEY_PENDING_VERIFIER)
            .commit()) {
            "The pending auth state could not be stored."
        }
    }

    open fun getPendingOAuth(): PendingOAuthRequest? {
        val json = readPendingAuth() ?: return null
        return runCatching {
            val flow = NativeOAuthFlow.fromStorage(json.optString("flow", NativeOAuthFlow.LEGACY.storageValue))
                ?: throw IllegalArgumentException("Unsupported OAuth flow")
            val createdAt = json.optLong("createdAtMillis", 0L).takeIf { it > 0L }
                ?: System.currentTimeMillis()
            val expiresAt = json.optLong("expiresAtMillis", 0L).takeIf { it > 0L }
                ?: createdAt + 15 * 60_000L
            PendingOAuthRequest(
                state = json.getString("state"),
                verifier = json.getString("verifier"),
                flow = flow,
                createdAtMillis = createdAt,
                expiresAtMillis = expiresAt,
                attemptToken = json.optionalString("attemptToken"),
                expectedUserId = json.optionalString("expectedUserId"),
                verifiedUserId = json.optionalString("verifiedUserId"),
                verifiedAccessTokenHash = json.optionalString("verifiedAccessTokenHash")
            ).takeIf(::validPendingOAuth) ?: throw IllegalArgumentException("Invalid pending OAuth request")
        }.getOrElse {
            preferences.edit().remove(KEY_PENDING_AUTH).commit()
            null
        }
    }

    open fun setPendingState(state: String, verifier: String) {
        val now = System.currentTimeMillis()
        setPendingOAuth(PendingOAuthRequest(
            state = state,
            verifier = verifier,
            flow = NativeOAuthFlow.LEGACY,
            createdAtMillis = now,
            expiresAtMillis = now + 15 * 60_000L
        ))
    }

    open fun getPendingState(): String? = getPendingOAuth()?.state

    open fun getPendingVerifier(): String? = getPendingOAuth()?.verifier

    open fun clearPendingState() {
        check(preferences.edit()
            .remove(KEY_PENDING_AUTH)
            .remove(KEY_PENDING_STATE)
            .remove(KEY_PENDING_VERIFIER)
            .commit()) {
            "The pending auth state could not be cleared."
        }
    }

    private fun validPendingOAuth(pending: PendingOAuthRequest): Boolean {
        val hasVerifiedIdentity = pending.verifiedUserId != null || pending.verifiedAccessTokenHash != null
        return pending.state.matches(Regex("^[A-Za-z0-9_-]{16,128}$"))
            && pending.verifier.length in 43..128
            && pending.verifier.matches(Regex("^[A-Za-z0-9._~-]+$"))
            && pending.createdAtMillis > 0L
            && pending.expiresAtMillis > pending.createdAtMillis
            && pending.expiresAtMillis <= pending.createdAtMillis + 15 * 60_000L
            && (pending.flow != NativeOAuthFlow.TELEGRAM_ACTIVATION
                || pending.attemptToken?.matches(Regex("^[A-Za-z0-9_-]{43}$")) == true)
            && (pending.flow != NativeOAuthFlow.TELEGRAM_LINK
                || pending.expectedUserId?.matches(UUID_PATTERN) == true)
            && (!hasVerifiedIdentity || (
                pending.verifiedUserId?.matches(UUID_PATTERN) == true
                    && pending.verifiedAccessTokenHash?.matches(Regex("^[0-9a-f]{64}$")) == true
            ))
    }

    open fun setPendingEmailOtp(attempt: PendingEmailOtpAttempt) {
        val encrypted = encrypt(JSONObject().apply {
            put("attemptToken", attempt.attemptToken)
            put("email", attempt.email)
            put("purpose", attempt.purpose)
            put("expiresAtMillis", attempt.expiresAtMillis)
            put("resendAtMillis", attempt.resendAtMillis)
            put("verifiedUserId", attempt.verifiedUserId ?: JSONObject.NULL)
            put("verifiedAccessTokenHash", attempt.verifiedAccessTokenHash ?: JSONObject.NULL)
        }.toString())
        check(preferences.edit().putString(KEY_PENDING_EMAIL_OTP, encrypted).commit()) {
            "The pending email-code request could not be stored."
        }
    }

    open fun getPendingEmailOtp(): PendingEmailOtpAttempt? {
        val encoded = preferences.getString(KEY_PENDING_EMAIL_OTP, null) ?: return null
        return runCatching {
            val json = JSONObject(decrypt(encoded))
            PendingEmailOtpAttempt(
                attemptToken = json.getString("attemptToken"),
                email = json.getString("email"),
                purpose = json.getString("purpose"),
                expiresAtMillis = json.getLong("expiresAtMillis"),
                resendAtMillis = json.getLong("resendAtMillis"),
                verifiedUserId = if (!json.has("verifiedUserId") || json.isNull("verifiedUserId")) null
                    else json.optString("verifiedUserId").takeIf(String::isNotBlank),
                verifiedAccessTokenHash = if (!json.has("verifiedAccessTokenHash") || json.isNull("verifiedAccessTokenHash")) null
                    else json.optString("verifiedAccessTokenHash").takeIf(String::isNotBlank)
            ).takeIf {
                val hasVerifiedIdentity = it.verifiedUserId != null || it.verifiedAccessTokenHash != null
                it.attemptToken.matches(Regex("^[A-Za-z0-9_-]{43}$"))
                    && it.email == it.email.trim().lowercase()
                    && it.purpose in setOf("sign_in", "activation")
                    && (!hasVerifiedIdentity || (
                        it.verifiedUserId?.matches(Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")) == true
                            && it.verifiedAccessTokenHash?.matches(Regex("^[0-9a-f]{64}$")) == true
                    ))
            } ?: throw IllegalArgumentException("Invalid pending email OTP")
        }.getOrElse {
            preferences.edit().remove(KEY_PENDING_EMAIL_OTP).commit()
            null
        }
    }

    open fun clearPendingEmailOtp() {
        check(preferences.edit().remove(KEY_PENDING_EMAIL_OTP).commit()) {
            "The pending email-code request could not be cleared."
        }
    }

    private fun readPendingAuth(): JSONObject? {
        val encoded = preferences.getString(KEY_PENDING_AUTH, null) ?: return null
        return runCatching { JSONObject(decrypt(encoded)) }.getOrElse {
            // An unusable verifier can never complete PKCE. Remove only that
            // pending request; the independent local database remains intact.
            preferences.edit().remove(KEY_PENDING_AUTH).commit()
            null
        }
    }

    private fun JSONObject.optionalString(name: String): String? =
        if (!has(name) || isNull(name)) null else optString(name).takeIf(String::isNotBlank)

    private fun recordReadProblem(error: Exception) {
        inMemoryReadProblem = SESSION_READ_PROBLEM
        val isDigestFailure = error is AEADBadTagException || error is BadPaddingException
            || error.cause is AEADBadTagException || error.cause is BadPaddingException
        val isKeyLoss = error is java.security.KeyStoreException
            || error is java.security.UnrecoverableKeyException
            || error.cause is java.security.KeyStoreException
            || isDigestFailure
        try {
            val editor = preferences.edit().putString(KEY_SESSION_READ_PROBLEM, SESSION_READ_PROBLEM)
            // Cryptographic key loss makes the ciphertext unrecoverable. Other
            // malformed values remain preserved until the user explicitly
            // replaces or clears the session.
            if (isKeyLoss) editor.remove(KEY_SESSION)
            editor.commit()
        } catch (_: Exception) {}
        if (isKeyLoss) {
            try { KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(KEY_ALIAS) } catch (_: Exception) {}
        }
    }

    private fun clearReadProblemAfterVerifiedRead() {
        if (readProblem() == null) return
        try {
            if (preferences.edit().remove(KEY_SESSION_READ_PROBLEM).commit()) {
                inMemoryReadProblem = null
            }
        } catch (_: Exception) {}
    }

    private fun key(): SecretKey {
        try {
            val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            val existing = store.getKey(KEY_ALIAS, null) as? SecretKey
            if (existing != null) return existing
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply {
                init(
                    KeyGenParameterSpec.Builder(
                        KEY_ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                    )
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setUserAuthenticationRequired(false)
                        .setInvalidatedByBiometricEnrollment(false)
                        .build()
                )
            }.generateKey()
        } catch (e: Exception) {
            // If KeyStore is unavailable (e.g., Robolectric), fallback to an in-memory key is handled by the test double.
            // In production, re-throw to let read() clear the stale entry.
            throw e
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val ciphertext = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return "${Base64.encodeToString(cipher.iv, Base64.NO_WRAP)}:${Base64.encodeToString(ciphertext, Base64.NO_WRAP)}"
    }

    private fun decrypt(value: String): String {
        val parts = value.split(':', limit = 2)
        require(parts.size == 2)
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        }
        return String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8)
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "goalflow_native_session"
        const val KEY_SESSION = "encrypted_session"
        const val KEY_SESSION_READ_PROBLEM = "session_read_problem"
        const val KEY_PENDING_AUTH = "encrypted_pending_auth"
        const val KEY_PENDING_EMAIL_OTP = "encrypted_pending_email_otp"
        // Removed on every write/clear to purge pre-PKCE plaintext state.
        const val KEY_PENDING_STATE = "pending_oauth_state"
        const val KEY_PENDING_VERIFIER = "pending_code_verifier"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val SESSION_READ_PROBLEM = "Cloud session storage is unreadable. Local commitments and queued changes were not deleted; sign in again to replace the damaged session."
        val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    }
}
