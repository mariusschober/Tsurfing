package com.mariusschober.goalflow.nativeapp.sync

import okhttp3.MediaType
import okhttp3.ResponseBody
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.BufferedSource
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class NativeSyncResponseLimitTest {
    @Test
    fun `bounded reader returns a complete response within the limit`() {
        assertEquals("safe", readNativeSyncResponse("safe".toResponseBody(), 4))
    }

    @Test
    fun `bounded reader rejects an oversized declared response`() {
        expectProtocolFailure { readNativeSyncResponse("12345".toResponseBody(), 4) }
    }

    @Test
    fun `bounded reader rejects an oversized streaming response`() {
        val body = object : ResponseBody() {
            override fun contentType(): MediaType? = null
            override fun contentLength(): Long = -1L
            override fun source(): BufferedSource = Buffer().writeUtf8("12345")
        }
        expectProtocolFailure { readNativeSyncResponse(body, 4) }
    }

    private fun expectProtocolFailure(block: () -> Unit) {
        try {
            block()
            fail("Expected NativeSyncProtocolException")
        } catch (_: NativeSyncProtocolException) {
            // Expected. Callers leave the outbox and cursor unchanged.
        }
    }
}
