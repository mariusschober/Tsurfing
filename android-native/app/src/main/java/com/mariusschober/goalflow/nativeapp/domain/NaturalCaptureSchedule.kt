package com.mariusschober.goalflow.nativeapp.domain

import java.time.LocalDate
import java.time.YearMonth

data class NaturalCaptureSchedule(val title: String, val scheduledFor: String, val precision: SchedulePrecision)

fun parseNaturalCaptureSchedule(title: String, today: LocalDate): NaturalCaptureSchedule? {
    val months = listOf("january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december")
    val weekdays = listOf("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")
    val pattern = Regex("""(?<![\w/#@-])(?:in\s+([1-9]\d{0,3})\s+(days?|weeks?|months?)|next\s+(week|month)|today|tomorrow|(?:next\s+)?(?:${weekdays.joinToString("|")})|(?:in\s+)?(?:${months.joinToString("|")})(?:\s+\d{4})?)(?![\w/-])""", RegexOption.IGNORE_CASE)
    for (match in pattern.findAll(title)) {
        val token = match.value.lowercase(java.util.Locale.ROOT).replace(Regex("""\s+"""), " ")
        var date = today
        var precision = SchedulePrecision.DAY
        if (match.groupValues[1].isNotEmpty()) {
            val count = match.groupValues[1].toLong()
            val unit = match.groupValues[2].lowercase(java.util.Locale.ROOT)
            if (unit.startsWith("month")) {
                date = YearMonth.from(today).plusMonths(count).atDay(1)
                precision = SchedulePrecision.MONTH
            } else date = today.plusDays(count * if (unit.startsWith("week")) 7 else 1)
        } else when (token) {
            "today" -> Unit
            "tomorrow" -> date = today.plusDays(1)
            "next week" -> date = today.plusWeeks(1)
            "next month" -> { date = YearMonth.from(today).plusMonths(1).atDay(1); precision = SchedulePrecision.MONTH }
            else -> {
                val weekday = weekdays.indexOf(token.removePrefix("next "))
                if (weekday >= 0) {
                    val distance = (weekday - today.dayOfWeek.value % 7 + 7) % 7
                    date = today.plusDays((if (distance == 0) 7 else distance).toLong())
                } else {
                    if ((token == "may" || token == "march") && match.value == token) continue
                    val parts = token.removePrefix("in ").split(" ")
                    val month = months.indexOf(parts[0]) + 1
                    var year = parts.getOrNull(1)?.toInt() ?: today.year
                    if (parts.size == 1 && month <= today.monthValue) year++
                    date = LocalDate.of(year, month, 1)
                    precision = SchedulePrecision.MONTH
                }
            }
        }
        val scheduledFor = if (precision == SchedulePrecision.MONTH) YearMonth.from(date).toString() else date.toString()
        return NaturalCaptureSchedule(title.removeRange(match.range).replace(Regex("""\s+"""), " ").trim(), scheduledFor, precision)
    }
    return null
}
