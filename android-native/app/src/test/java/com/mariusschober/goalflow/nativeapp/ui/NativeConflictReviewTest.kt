package com.mariusschober.goalflow.nativeapp.ui

import com.mariusschober.goalflow.nativeapp.data.SyncConflictEntity
import org.junit.Assert.*
import org.junit.Test

class NativeConflictReviewTest {
    private fun conflict(local: String, cloud: String, localDeleted: String? = null, cloudDeleted: String? = null) =
        SyncConflictEntity("conflict", "tasks", "task", "mutation", local, localDeleted,
            "[]", cloud, cloudDeleted, 4, "2026-09-05T10:00:00Z")

    @Test fun `delete versus saved version names the task and the consequence of each choice`() {
        val result = nativeConflictReview(conflict("""{"title":"Prepare report"}""",
            """{"title":"Prepare report"}""", cloudDeleted = "2026-09-05T10:00:00Z"))
        assertEquals("Prepare report", result.title)
        assertEquals(NativeConflictDifference("Availability", "Saved", "Deleted"), result.differences.single())
        assertEquals("Keep cloud deletion", result.cloudChoice)
        assertEquals("Keep device version", result.deviceChoice)
    }

    @Test fun `different task fields display both actual values`() {
        val result = nativeConflictReview(conflict(
            """{"title":"Report","duration":30,"scheduledFor":"2026-09-05"}""",
            """{"title":"Final report","duration":45,"scheduledFor":"2026-09-06"}"""))
        assertTrue(result.differences.contains(NativeConflictDifference("Duration", "30 min", "45 min")))
        assertTrue(result.differences.contains(NativeConflictDifference("Scheduled day", "2026-09-05", "2026-09-06")))
        assertTrue(result.differences.contains(NativeConflictDifference("Title", "Report", "Final report")))
    }

    @Test fun `equivalent objects do not invent a content difference from field order or timestamps`() {
        val result = nativeConflictReview(conflict(
            """{"title":"Same task","updatedAt":"earlier","details":{"a":1,"b":2}}""",
            """{"details":{"b":2,"a":1},"updatedAt":"later","title":"Same task"}"""))
        assertTrue(result.differences.isEmpty())
        assertTrue(result.summary.contains("contents match"))
    }

    @Test fun `two deletions explain that the desired outcome matches`() {
        val result = nativeConflictReview(conflict("""{"title":"Old test"}""", """{"title":"Old test"}""",
            "2026-09-05T09:00:00Z", "2026-09-05T10:00:00Z"))
        assertTrue(result.summary.contains("Both copies are already deleted"))
        assertEquals("Keep device deletion", result.deviceChoice)
        assertEquals("Keep cloud deletion", result.cloudChoice)
    }

    @Test fun `missing cloud data clearly describes removal`() {
        val result = nativeConflictReview(conflict("""{"title":"Local task"}""", ""))
        assertEquals("Remove device copy", result.cloudChoice)
        assertTrue(result.summary.contains("cloud no longer has"))
    }

    @Test fun `malformed content is never described as matching`() {
        val result = nativeConflictReview(conflict("broken", "broken"))
        assertFalse(result.summary.contains("contents match"))
        assertTrue(result.summary.contains("cannot be fully compared"))
    }
}
