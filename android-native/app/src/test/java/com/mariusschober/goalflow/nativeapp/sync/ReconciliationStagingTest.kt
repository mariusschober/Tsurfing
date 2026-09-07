package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.ActionJson
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class ReconciliationStagingTest {
    @Test
    fun `shared manifest hashes every original byte and bounds each request`() {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/reconciliation-staging-v1.json").isFile }
        val fixture = JSONObject(File(root, "tests/fixtures/s2/reconciliation-staging-v1.json").readText())
        val body = fixture.getString("bodyPrefix") + fixture.getString("bodyUnit").repeat(fixture.getInt("repetitions")) + fixture.getString("bodySuffix")
        val upload = ReconciliationUpload.prepare(body)
        assertEquals(ActionJson.canonical(fixture.getJSONObject("manifest")), ActionJson.canonical(upload.manifest))
        val restored = upload.chunks.flatMap { Base64.getDecoder().decode(it.getString("data")).toList() }.toByteArray()
        assertEquals(body, restored.toString(Charsets.UTF_8))
        for ((index, chunk) in upload.chunks.withIndex()) {
            assertTrue(chunk.toString().toByteArray(Charsets.UTF_8).size <= 262144)
            assertEquals(fixture.getJSONArray("chunkHashes").getString(index), chunk.getString("chunkSha256"))
            val ack = JSONObject(chunk.toString()).apply { remove("data"); put("staged", true) }
            ReconciliationUpload.verifyAck(chunk, ack.toString())
            ack.put("chunkSha256", "0".repeat(64))
            try { ReconciliationUpload.verifyAck(chunk, ack.toString()); fail("Wrong chunk acknowledgment must fail") }
            catch (_: NativeSyncProtocolException) { }
        }
        assertEquals(ActionJson.canonical(upload.manifest), ActionJson.canonical(ReconciliationUpload.prepare(body).manifest))
    }

    @Test
    fun `entry limit selects staging and unsupported size stays preserved`() {
        val candidate = JSONObject().put("localHistory", JSONArray().apply { repeat(1001) { put(JSONObject.NULL) } })
        assertTrue(ReconciliationUpload.prepare(candidate.toString()).manifest != null)
        val oversized = candidate.put("notes", "x".repeat(4 * 1024 * 1024)).toString()
        try { ReconciliationUpload.prepare(oversized); fail("An oversize candidate must fail closed") }
        catch (failure: NativeSyncProtocolException) { assertTrue(failure.message.orEmpty().contains("preserved")) }
        assertEquals(1001, JSONObject(oversized).getJSONArray("localHistory").length())
    }
}
