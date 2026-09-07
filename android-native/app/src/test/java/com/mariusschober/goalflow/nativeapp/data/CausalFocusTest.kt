package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class CausalFocusTest {
    @Test
    fun `terminal pause timestamps and unsafe elapsed integers remain inspectable errors`() {
        val baseline = NativeFocusSessionRecord.start("task-F", 600, java.time.Instant.parse("2026-09-07T12:00:00Z")).toJson()
        val malformed = listOf(
            JSONObject(baseline.toString()).put("phase", "completed").put("endedAt", baseline.getString("startedAt")).put("pausedAt", baseline.getString("startedAt")),
            JSONObject(baseline.toString()).put("elapsedSeconds", 9007199254740992L)
        )
        for (value in malformed) {
            val before = value.toString()
            try {
                CausalFocus.initial("11111111-1111-4111-8111-111111111111", value)
                fail("Invalid baseline must not become active")
            } catch (_: IllegalArgumentException) { }
            assertEquals(before, value.toString())
        }
    }
    @Test
    fun `shared causal focus fixtures retain action and terminal identities`() {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/focus-v1.json").isFile }
        val fixture = JSONObject(File(root, "tests/fixtures/s2/focus-v1.json").readText())
        val cases = fixture.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            var journal = CausalFocus.initial(fixture.getString("accountId"))
            val commands = case.getJSONArray("commands")
            for (i in 0 until commands.length()) {
                val before = journal.toString()
                val reply = CausalFocus.apply(journal, commands.getJSONObject(i))
                assertEquals(before, journal.toString())
                assertEquals(case.getString("name"), case.getJSONArray("outcomeCodes").getString(i), reply.outcome.getString("code"))
                journal = reply.journal
            }
            val actual = journal.getJSONObject("sessions").getJSONObject(journal.getString("currentSessionId")).getJSONObject("projection")
            val expected = case.getJSONObject("expected")
            for (key in expected.keys()) assertEquals(case.getString("name") + ":" + key, expected.get(key).toString(), actual.get(key).toString())
            if (case.getString("name") == "completed-F-never-revives-after-G") {
                assertEquals("completed", journal.getJSONObject("sessions").getJSONObject("ffffffff-ffff-4fff-8fff-ffffffffffff").getJSONObject("projection").getString("phase"))
            }
        }
    }
}
