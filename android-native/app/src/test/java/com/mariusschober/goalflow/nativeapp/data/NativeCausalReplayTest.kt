package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class NativeCausalReplayTest {
    @Test fun `an earlier admission basis survives a later terminal transition`() {
        val fixture = fixture(); val owner = fixture.getString("accountId"); val history = fixture.getJSONObject("history")
        val preserved = history.toString()
        val beforeStart = NativeCausalReplay.replayAt(owner, history, 1)
        val running = NativeCausalReplay.replayAt(owner, history, 2)
        val completed = NativeCausalReplay.replay(owner, history)
        assertEquals(1, beforeStart.receipts.length())
        assertEquals(2, running.receipts.length())
        assertEquals("active", running.tracking.getJSONObject("focusSession").getString("phase"))
        assertEquals("completed", completed.tracking.getJSONObject("focusSession").getString("phase"))
        assertNotEquals(ActionJson.canonical(running.focus), ActionJson.canonical(completed.focus))
        // A caller may overlay pending commands on the result. No returned
        // object may alias retained history or a subsequent replay result.
        running.tracking.put("planViewCount", 900)
        running.focus.getJSONObject("sessions").remove(running.focus.getString("currentSessionId"))
        running.baselines.getJSONObject(running.tracking.getString("date")).getJSONObject("counts").put("planViewCount", 900)
        assertEquals(preserved, history.toString())
        val repeated = NativeCausalReplay.replayAt(owner, history, 2)
        assertEquals(28, repeated.tracking.getInt("planViewCount"))
        assertEquals(1, repeated.focus.getJSONObject("sessions").length())
        assertEquals(27, repeated.baselines.getJSONObject(repeated.tracking.getString("date")).getJSONObject("counts").getInt("planViewCount"))
    }

    @Test fun `a requested basis cannot use an undownloaded revision or hide damaged saved evidence`() {
        val fixture = fixture(); val owner = fixture.getString("accountId"); val history = fixture.getJSONObject("history")
        for (revision in listOf(-1L, 5L, Long.MAX_VALUE)) {
            assertTrue(runCatching { NativeCausalReplay.replayAt(owner, history, revision) }.isFailure)
        }
        val cutover = NativeCausalReplay.replayAt(owner, history, 0)
        assertEquals(27, cutover.tracking.getInt("planViewCount"))
        assertEquals(0, cutover.receipts.length())
        history.getJSONObject("entries").getJSONObject("4").put("sha256", "0".repeat(64))
        assertTrue(runCatching { NativeCausalReplay.replayAt(owner, history, 0) }.isFailure)
    }

    @Test fun `a new counter day cannot borrow the cutover baseline identity`() {
        val fixture = fixture(); val history = fixture.getJSONObject("reusedBaselineHistory")
        NativeSavedCausalHistory.validate(fixture.getString("accountId"), history)
        val failure = runCatching { NativeCausalReplay.replay(fixture.getString("accountId"), history) }.exceptionOrNull()
        assertTrue(failure?.message?.contains("immutable identity") == true)
    }
    private fun fixture(): JSONObject {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/history-replay-v2.json").isFile }
        return JSONObject(File(root, "tests/fixtures/s2/history-replay-v2.json").readText())
    }
    @Test fun `shared complete history reconstructs each operation without selecting latest snapshots`() {
        val fixture = fixture(); val result = NativeCausalReplay.replay(fixture.getString("accountId"), fixture.getJSONObject("history"))
        assertEquals(28, result.tracking.getInt("planViewCount")); assertEquals(3, result.tracking.getInt("dailyPostponeCount"))
        assertEquals("completed", result.tracking.getJSONObject("focusSession").getString("phase"))
        assertEquals(4, result.receipts.length()); assertEquals(1, result.events.length())
    }
    @Test fun `valid hashes and matching receipt counts cannot fabricate an increment`() {
        val fixture = fixture(); val owner = fixture.getString("accountId"); val history = fixture.getJSONObject("history")
        val saved = history.getJSONObject("entries").getJSONObject("1"); val entry = JSONObject(saved.getString("body"))
        entry.getJSONObject("receipt").getJSONObject("outcome").getJSONObject("counts").put("planViewCount", 29)
        entry.getJSONObject("receipt").getJSONObject("record").getJSONObject("payload").put("planViewCount", 29)
        val body = entry.toString(); saved.put("body", body).put("sha256", NativeCausalHistoryProtocol.hash(body.toByteArray(Charsets.UTF_8)))
        NativeSavedCausalHistory.validate(owner, history)
        val failure = runCatching { NativeCausalReplay.replay(owner, history) }.exceptionOrNull()
        assertTrue(failure?.message?.contains("conservation") == true)
    }
    @Test fun `repeated action identity is rejected even with a fresh projection revision`() {
        val fixture = fixture(); val history = fixture.getJSONObject("history")
        val entry = JSONObject(history.getJSONObject("entries").getJSONObject("1").getString("body"))
        entry.put("revision", 5); entry.getJSONObject("receipt").put("projectionRevision", 5)
        val body = entry.toString()
        history.getJSONObject("entries").put("5", JSONObject().put("body", body).put("sha256", NativeCausalHistoryProtocol.hash(body.toByteArray(Charsets.UTF_8))))
        history.put("throughRevision", 5).put("downloadedRevision", 5)
        val failure = runCatching { NativeCausalReplay.replay(fixture.getString("accountId"), history) }.exceptionOrNull()
        assertTrue(failure?.message?.contains("immutable action identity") == true)
    }
}
