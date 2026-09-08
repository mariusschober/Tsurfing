package com.mariusschober.goalflow.nativeapp.data

import com.mariusschober.goalflow.nativeapp.sync.NativeCausalTransport
import com.mariusschober.goalflow.nativeapp.sync.NativeCausalTransportException
import com.mariusschober.goalflow.nativeapp.sync.NativeHttpResponse
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class NativeCausalProtocolTest {
    private fun fixture(): JSONObject {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/action-receipts-v2.json").isFile }
        return JSONObject(File(root, "tests/fixtures/s2/action-receipts-v2.json").readText())
    }

    @Test fun `shared receipts preserve evidence and retries transmit exact saved bytes`() {
        val fixture = fixture(); val owner = fixture.getString("accountId"); val cases = fixture.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index); val saved = case.getJSONObject("operation").toString(2)
            val receipt = case.getJSONObject("receipt")
            repeat(2) {
                val result = NativeCausalTransport.send(owner, saved) { path, method, body ->
                    assertEquals("/api/v1/sync/actions", path); assertEquals("POST", method); assertEquals(saved, body)
                    NativeHttpResponse(200, receipt.toString())
                }
                assertEquals(ActionJson.canonical(receipt), ActionJson.canonical(result))
                assertEquals("2026-09-08T00:00:00.123456+00:00", result.getJSONObject("record").getString("updated_at"))
            }
            for (damage in listOf<(JSONObject) -> Unit>(
                { it.put("projectionRevision", 0) },
                { it.getJSONObject("operation").getJSONObject("command").put("actorId", "changed") },
                { it.getJSONObject("record").put("user_id", "22222222-2222-4222-8222-222222222222") },
                { it.getJSONObject("record").remove("deleted_at") }
            )) {
                val altered = JSONObject(receipt.toString()); damage(altered)
                assertTrue(runCatching { NativeCausalProtocol.receipt(owner, JSONObject(saved), altered) }.isFailure)
            }
        }
    }

    @Test fun `UTF8 envelope limit and account validation happen before sending`() {
        val fixture = fixture(); val op = fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("operation")
        op.getJSONObject("command").put("large", "界".repeat(90_000))
        val saved = op.toString(); assertTrue(saved.length < 256 * 1024)
        val failure = runCatching { NativeCausalTransport.send(fixture.getString("accountId"), saved) { _, _, _ -> error("Must not send") } }.exceptionOrNull()
        assertTrue(failure is NativeCausalTransportException && failure.status == 413 && !failure.retryable)
        op.getJSONObject("command").remove("large")
        var called = false
        assertTrue(runCatching { NativeCausalTransport.send("22222222-2222-4222-8222-222222222222", op.toString()) { _, _, _ -> called = true; error("Must not send") } }.isFailure)
        assertFalse(called)
    }

    @Test fun `HTTP failure classification does not expose response contents`() {
        val fixture = fixture(); val saved = fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("operation").toString()
        for (status in listOf(409, 413, 429, 503)) {
            val failure = runCatching { NativeCausalTransport.send(fixture.getString("accountId"), saved) { _, _, _ -> NativeHttpResponse(status, "private fixture diagnostic") } }.exceptionOrNull()
            assertTrue(failure is NativeCausalTransportException)
            failure as NativeCausalTransportException
            assertEquals(status == 429 || status == 503, failure.retryable)
            assertFalse(failure.message!!.contains("private fixture"))
        }
    }
}
