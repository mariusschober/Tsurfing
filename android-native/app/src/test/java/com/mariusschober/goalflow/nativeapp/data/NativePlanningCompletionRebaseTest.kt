package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativePlanningCompletionRebaseTest {
    private fun task() = JSONObject().put("id", "task").put("completed", false)
        .put("description", "before").put("actualDuration", 1).put("flowState", 1).put("plannedOrder", 0)
    private fun completed(before: JSONObject) = JSONObject(before.toString()).put("completed", true)
        .put("lifecycleStatus", "completed").put("completedAt", 10)
    private fun rebase(before: JSONObject, after: JSONObject, synced: JSONObject) =
        NativePlanningCompletionRebase.rebase("tasks", before, after, synced, 30)
    private fun conflict(before: JSONObject, after: JSONObject, synced: JSONObject, key: String) {
        val original = listOf(before, after, synced).map(ActionJson::canonical)
        try {
            rebase(before, after, synced)
            fail("Expected the concurrent $key change to remain in review")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message.orEmpty().contains("Both devices changed $key"))
        }
        assertEquals(original, listOf(before, after, synced).map(ActionJson::canonical))
    }

    @Test fun `completion cannot overwrite concurrent notes duration or flow rating`() {
        for ((key, local, remote) in listOf(
            Triple("description", "local note", "remote note"),
            Triple("actualDuration", 12, 20), Triple("flowState", 3, 5)
        )) {
            val before = task()
            conflict(before, completed(before).put(key, local), JSONObject(before.toString()).put(key, remote), key)
        }
    }

    @Test fun `identical changes on both devices are not conflicts`() {
        for ((key, value) in listOf("description" to "same note", "actualDuration" to 12, "flowState" to 3)) {
            val before = task(); val after = completed(before).put(key, value)
            val synced = JSONObject(before.toString()).put(key, value).put("plannedOrder", 4)
            assertEquals(ActionJson.canonical(JSONObject(after.toString()).put("plannedOrder", 4)),
                ActionJson.canonical(rebase(before, after, synced)))
        }
    }

    @Test fun `independent remote metadata and local final notes both survive`() {
        val before = task(); val after = completed(before).put("description", "local note")
            .put("updatedAt", 20).put("__goalflowCompletionUndo", JSONObject().put("earnedXp", 30))
        val synced = JSONObject(before.toString()).put("plannedOrder", 4).put("title", "remote title")
            .put("scheduledFor", "2026-09-09").put("updatedAt", 15)
        val original = listOf(before, after, synced).map(ActionJson::canonical)
        val result = rebase(before, after, synced)
        assertEquals("local note", result.getString("description"))
        assertEquals(4, result.getInt("plannedOrder")); assertEquals("remote title", result.getString("title"))
        assertEquals("2026-09-09", result.getString("scheduledFor")); assertEquals(20, result.getInt("updatedAt"))
        assertEquals(30, result.getJSONObject("__goalflowCompletionUndo").getInt("earnedXp"))
        assertEquals(original, listOf(before, after, synced).map(ActionJson::canonical))
    }

    @Test fun `remote only notes remain untouched`() {
        val before = task()
        assertEquals("remote note", rebase(before, completed(before),
            JSONObject(before.toString()).put("description", "remote note")).getString("description"))
    }

    @Test fun `empty and deleted notes do not erase a competing remote note`() {
        val before = task(); val remote = JSONObject(before.toString()).put("description", "remote note")
        val empty = completed(before).put("description", "")
        assertEquals("", rebase(before, empty, before).getString("description"))
        conflict(before, empty, remote, "description")
        val removed = completed(before).apply { remove("description") }
        assertFalse(rebase(before, removed, before).has("description"))
        conflict(before, removed, remote, "description")
    }
}
