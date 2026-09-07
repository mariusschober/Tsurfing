package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.BigInteger
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatterBuilder

/** JSON-domain validation shared by the private causal-action ledger. */
internal object ActionJson {
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
    val instantFormatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    const val MAX_SAFE_INTEGER = 9007199254740991L
    fun identity(value: Any?): Boolean = value is String && uuid.matches(value)
    fun integer(value: Any?): Long? {
        if (value !is Number) return null
        return runCatching {
            val decimal = BigDecimal(value.toString())
            val exact = decimal.longValueExact()
            exact.takeIf { it in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER }
        }.getOrNull()
    }
    fun day(value: Any?): Boolean = value is String && Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(value)
        && runCatching { LocalDate.parse(value).toString() == value }.getOrDefault(false)
    fun instant(value: Any?): Boolean = value is String
        && Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$").matches(value)
        && runCatching { instantFormatter.format(Instant.parse(value)) == value }.getOrDefault(false)
    fun canonical(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { key ->
            JSONObject.quote(key) + ":" + canonical(value.get(key))
        }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        is Number -> BigDecimal(value.toString()).stripTrailingZeros().toPlainString()
        is Boolean -> value.toString()
        else -> throw IllegalArgumentException("Invalid action JSON")
    }
}

class CounterLedgerException(val code: String) : IllegalArgumentException(code)

/** Establishing baselines and authorizing corrections are transaction duties.
 * This pure equation never infers an increment from a tracking snapshot. */
object CounterLedger {
    fun project(baseline: JSONObject, events: JSONArray): JSONObject {
        fun fail(code: String): Nothing = throw CounterLedgerException(code)
        val counts = baseline.optJSONObject("counts") ?: fail("INVALID_BASELINE")
        val evidence = baseline.optJSONArray("evidenceIds") ?: fail("INVALID_BASELINE")
        val plans = ActionJson.integer(counts.opt("planViewCount")) ?: fail("INVALID_BASELINE")
        val postpones = ActionJson.integer(counts.opt("dailyPostponeCount")) ?: fail("INVALID_BASELINE")
        if (ActionJson.integer(baseline.opt("schemaVersion")) != 1L
            || !ActionJson.identity(baseline.opt("baselineId")) || !ActionJson.identity(baseline.opt("accountId"))
            || !ActionJson.day(baseline.opt("day")) || plans < 0 || postpones < 0) fail("INVALID_BASELINE")
        val evidenceIds = mutableSetOf<String>()
        for (index in 0 until evidence.length()) {
            val id = evidence.opt(index)
            if (!ActionJson.identity(id) || !evidenceIds.add(id as String)) fail("INVALID_BASELINE")
        }
        val totals = mutableMapOf("planViewCount" to BigInteger.valueOf(plans), "dailyPostponeCount" to BigInteger.valueOf(postpones))
        val seen = mutableMapOf<String, String>()
        for (index in 0 until events.length()) {
            val event = events.optJSONObject(index) ?: fail("INVALID_DELTA")
            val actor = event.opt("actorId")
            val zone = event.opt("timeZone")
            val delta = ActionJson.integer(event.opt("delta")) ?: fail("INVALID_DELTA")
            if (ActionJson.integer(event.opt("schemaVersion")) != 1L
                || !ActionJson.identity(event.opt("actionId")) || !ActionJson.identity(event.opt("accountId"))
                || actor !is String || actor.length !in 1..240 || !ActionJson.day(event.opt("day"))
                || zone !is String || !Regex("^[A-Za-z0-9_+./-]{1,128}$").matches(zone)
                || event.opt("counter") !in totals.keys || delta == 0L || !ActionJson.instant(event.opt("capturedAt"))
                || !event.has("businessActionId") || !event.has("correctionOf")
                || (!event.isNull("businessActionId") && !ActionJson.identity(event.opt("businessActionId")))
                || (if (event.isNull("correctionOf")) delta != 1L else !ActionJson.identity(event.opt("correctionOf")))) fail("INVALID_DELTA")
            if (event.getString("accountId") != baseline.getString("accountId")) fail("SCOPE_MISMATCH")
            val actionId = event.getString("actionId")
            if (actionId in evidenceIds) fail("IDENTITY_MISMATCH")
            val fingerprint = ActionJson.canonical(event)
            val previous = seen[actionId]
            if (previous != null && previous != fingerprint) fail("IDENTITY_MISMATCH")
            if (previous != null) continue
            seen[actionId] = fingerprint
            if (event.getString("day") != baseline.getString("day")) continue
            val counter = event.getString("counter")
            totals[counter] = totals.getValue(counter) + BigInteger.valueOf(delta)
        }
        val projection = JSONObject(counts.toString())
        for ((counter, total) in totals) {
            if (total < BigInteger.ZERO || total > BigInteger.valueOf(ActionJson.MAX_SAFE_INTEGER)) fail("RANGE")
            projection.put(counter, total.toLong())
        }
        return projection
    }
}
