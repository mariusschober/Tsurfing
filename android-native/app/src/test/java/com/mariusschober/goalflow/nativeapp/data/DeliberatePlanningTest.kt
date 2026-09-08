package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class DeliberatePlanningTest {
    @Test fun `shared planning fixtures preserve allowances costs and immutable duplicates`() {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/planning/deliberate-v1.json").isFile }
        val cases = JSONObject(File(root, "tests/fixtures/planning/deliberate-v1.json").readText()).getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i); val tasks = case.getJSONArray("available")
            val available = (0 until tasks.length()).map { tasks.getJSONObject(it).let { task -> DeliberatePlanning.Task(task.getString("id"), task.getInt("precedence")) } }
            val result = DeliberatePlanning.apply(case.getJSONObject("policy"), case.getJSONObject("command"), available, case.getLong("xp"), case.getString("setting"))
            val actual = JSONObject(result.receipt.toString()).apply { remove("command"); put("xp", result.xp) }
            assertEquals(case.getString("name"), ActionJson.canonical(case.getJSONObject("expected")), ActionJson.canonical(actual))
            val duplicate = DeliberatePlanning.apply(result.policy, case.getJSONObject("command"), available, result.xp, case.getString("setting"))
            assertTrue(duplicate.replay); assertEquals(result.xp, duplicate.xp)
            assertEquals(ActionJson.canonical(result.receipt), ActionJson.canonical(duplicate.receipt))
        }
    }
}
