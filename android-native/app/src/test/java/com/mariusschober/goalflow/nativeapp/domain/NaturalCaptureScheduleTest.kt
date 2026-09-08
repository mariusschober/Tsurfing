package com.mariusschober.goalflow.nativeapp.domain
import java.time.LocalDate
import org.junit.Test
import org.junit.Assert.*
class NaturalCaptureScheduleTest {
    @Test fun calendarPhrases() {
        val cases = listOf(
            listOf("2026-09-07", "Send report today", "2026-09-07", "day", "Send report"),
            listOf("2026-12-31", "Send report tomorrow", "2027-01-01", "day", "Send report"),
            listOf("2026-09-07", "Send report next week", "2026-09-14", "day", "Send report"),
            listOf("2026-12-31", "Send report next month", "2027-01", "month", "Send report"),
            listOf("2026-08-31", "Send report September", "2026-09", "month", "Send report"),
            listOf("2026-09-07", "Send report September", "2027-09", "month", "Send report"),
            listOf("2026-12-20", "Send report in 3 weeks", "2027-01-10", "day", "Send report"),
            listOf("2028-02-26", "Send report in 4 days", "2028-03-01", "day", "Send report"),
            listOf("2026-01-31", "Send report in 3 months", "2026-04", "month", "Send report"),
            listOf("2026-09-07", "Tomorrow send report", "2026-09-08", "day", "send report"),
            listOf("2026-09-07", "Send report Friday", "2026-09-11", "day", "Send report"),
            listOf("2026-09-07", "Send report in May", "2027-05", "month", "Send report")
        )
        for (case in cases) {
            val result = parseNaturalCaptureSchedule(case[1], LocalDate.parse(case[0]))!!
            assertEquals(case[1], case[2], result.scheduledFor)
            assertEquals(case[1], case[3].uppercase(), result.precision.name)
            assertEquals(case[1], case[4], result.title)
        }
    }
    @Test fun ordinaryWordsRemainTitleText() {
        for (title in listOf("We may review", "march forward", "Review months of notes", "Review in 0 days", "Visit https://example.com/today", "Review #September")) {
            assertNull(title, parseNaturalCaptureSchedule(title, LocalDate.parse("2026-09-07")))
        }
    }
}
