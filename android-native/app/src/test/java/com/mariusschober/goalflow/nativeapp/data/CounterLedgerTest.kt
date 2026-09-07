package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class CounterLedgerTest {
    @Test
    fun `shared counter fixtures conserve distinct actions in either order`() {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/counters-v1.json").isFile }
        val fixture = JSONObject(File(root, "tests/fixtures/s2/counters-v1.json").readText())
        val baseline = fixture.getJSONObject("baseline")
        val cases = fixture.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val events = case.getJSONArray("events")
            val reverse = JSONArray().apply { for (i in events.length() - 1 downTo 0) put(events.get(i)) }
            for (ordered in listOf(events, reverse)) {
                try {
                    val projection = CounterLedger.project(baseline, ordered)
                    if (case.has("error")) fail(case.getString("name") + " should reject")
                    assertEquals(case.getString("name"), ActionJson.canonical(case.getJSONObject("expected")), ActionJson.canonical(projection))
                } catch (error: CounterLedgerException) {
                    assertEquals(case.getString("name"), case.getString("error"), error.code)
                }
            }
        }
    }
}
