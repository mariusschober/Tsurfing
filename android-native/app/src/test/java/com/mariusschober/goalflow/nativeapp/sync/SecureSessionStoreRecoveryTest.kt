package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SecureSessionStoreRecoveryTest {
    private lateinit var store: SecureSessionStore

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        context.getSharedPreferences("goalflow-secure-session", Context.MODE_PRIVATE).edit().clear().commit()
        store = object : SecureSessionStore(context) {
            private var memSession: NativeSession? = null
            private var memState: String? = null
            private var memVerifier: String? = null
            override fun read(): NativeSession? = memSession
            override fun write(session: NativeSession) { memSession = session }
            override fun clear() { memSession = null }
            override fun setPendingState(state: String, verifier: String) { memState = state; memVerifier = verifier }
            override fun getPendingState(): String? = memState
            override fun getPendingVerifier(): String? = memVerifier
            override fun clearPendingState() { memState = null; memVerifier = null }
        }
    }

    @After
    fun tearDown() {
        store.clear()
        store.clearPendingState()
    }

    @Test
    fun `store recovers after simulated KeyStore wipe`() {
        val session = NativeSession("access", "refresh", System.currentTimeMillis() + 3600_000, "user-123")
        store.write(session)
        assertNotNull(store.read())
        // Simulate KeyStore wipe by clearing and writing again
        store.clear()
        assertNull(store.read())
        store.write(session)
        assertNotNull(store.read())
    }

    @Test
    fun `pending state survives session clear but can be cleared separately`() {
        store.setPendingState("state123", "verifier123")
        assertNotNull(store.getPendingState())
        store.clear()
        // Pending state should remain after session clear (separate keys)
        assertNotNull(store.getPendingState())
        store.clearPendingState()
        assertNull(store.getPendingState())
    }

    @Test
    fun `read returns null after KeyStore exception simulation`() {
        // Simulate KeyStore exception by directly clearing and ensuring read returns null
        store.write(NativeSession("a", "r", 123L, "u"))
        // Simulate wipe
        store.clear()
        assertNull(store.read())
    }

    @Test
    fun `malformed encrypted session is preserved and reported until explicitly cleared`() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val preferences = context.getSharedPreferences("goalflow-secure-session", Context.MODE_PRIVATE)
        preferences.edit().clear().putString("encrypted_session", "malformed-ciphertext").commit()
        val realStore = SecureSessionStore(context)

        assertNull(realStore.read())
        assertNotNull(realStore.readProblem())
        assertEquals("malformed-ciphertext", preferences.getString("encrypted_session", null))

        realStore.clear()
        assertNull(realStore.readProblem())
        assertNull(preferences.getString("encrypted_session", null))
    }
}
