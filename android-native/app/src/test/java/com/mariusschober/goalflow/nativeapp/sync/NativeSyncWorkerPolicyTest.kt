package com.mariusschober.goalflow.nativeapp.sync

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

class NativeSyncWorkerPolicyTest {
    @Test
    fun `transient transport failures retry only within a fixed budget`() {
        assertEquals(
            NativeSyncFailureDisposition.RETRY,
            nativeSyncFailureDisposition(IOException("offline"), runAttemptCount = 0)
        )
        assertEquals(
            NativeSyncFailureDisposition.RETRY,
            nativeSyncFailureDisposition(NativeAuthTransientException("auth unavailable"), runAttemptCount = 0)
        )
        assertEquals(
            NativeSyncFailureDisposition.STOP,
            nativeSyncFailureDisposition(IOException("still offline"), runAttemptCount = 5)
        )
    }

    @Test
    fun `authentication and protocol failures never retry forever`() {
        assertEquals(NativeSyncFailureDisposition.STOP, nativeSyncFailureDisposition(NativeSyncMfaRequired(), 0))
        assertEquals(
            NativeSyncFailureDisposition.STOP,
            nativeSyncFailureDisposition(AuthenticationExpiredDuringSync(), runAttemptCount = 0)
        )
        assertEquals(
            NativeSyncFailureDisposition.STOP,
            nativeSyncFailureDisposition(NativeSyncSessionChangedDuringSync(), runAttemptCount = 0)
        )
        assertEquals(
            NativeSyncFailureDisposition.STOP,
            nativeSyncFailureDisposition(NativeSyncProtocolException("invalid receipt"), runAttemptCount = 0)
        )
    }
}
