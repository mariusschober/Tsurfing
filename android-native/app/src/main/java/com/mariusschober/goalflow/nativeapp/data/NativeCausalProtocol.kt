package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Version-two action receipts are separate from legacy snapshot acceptance.
 * Validation returns the original object and never normalizes its evidence. */
object NativeCausalProtocol {
    fun operation(accountId: String, value: JSONObject): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("schemaVersion", "epoch", "type", "command")
            && ActionJson.integer(value.opt("schemaVersion")) == 2L
            && ActionJson.identity(value.opt("epoch")) && ActionJson.identity(accountId)) { "Invalid causal operation." }
        val command = value.getJSONObject("command")
        require(command.opt("accountId") == accountId) { "Causal operation account differs." }
        when (value.opt("type")) {
            "focus" -> {
                CausalFocus.validate(command)
                require(command.opt("kind") != "complete") { "Completion requires an atomic business operation." }
            }
            "counter" -> {
                require(command.has("correctionOf") && command.isNull("correctionOf")) { "Corrections require verified recovery." }
                val baseline = JSONObject().put("schemaVersion", 1).put("baselineId", accountId)
                    .put("accountId", accountId).put("day", command.opt("day"))
                    .put("counts", JSONObject().put("planViewCount", 0).put("dailyPostponeCount", 0))
                    .put("evidenceIds", JSONArray())
                CounterLedger.project(baseline, JSONArray().put(command))
            }
            "counterDay" -> NativeCausalJournal.validateDay(command, accountId)
            else -> error("Invalid causal operation kind.")
        }
        return value
    }

    fun receipt(accountId: String, operation: JSONObject, value: JSONObject): JSONObject {
        this.operation(accountId, operation)
        fun proof(condition: Boolean) = require(condition) { "Causal synchronization did not prove the exact operation receipt." }
        fun positive(value: Any?) = ActionJson.integer(value)?.let { it > 0 } == true
        proof(ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("epoch") == operation.opt("epoch")
            && ActionJson.canonical(value.opt("operation")) == ActionJson.canonical(operation)
            && value.opt("accepted") is Boolean && positive(value.opt("projectionRevision")))
        val record = value.getJSONObject("record")
        val payload = record.getJSONObject("payload")
        proof(record.opt("user_id") == accountId && record.opt("entity_type") == "tracking"
            && record.opt("entity_id") == "singleton" && positive(record.opt("version")) && positive(record.opt("server_version"))
            && record.opt("device_id") is String && record.getString("device_id").isNotEmpty()
            && record.opt("updated_at") is String && runCatching { Instant.parse(record.getString("updated_at")) }.isSuccess
            && record.has("deleted_at") && record.isNull("deleted_at"))
        val command = operation.getJSONObject("command")
        when (operation.getString("type")) {
            "focus" -> {
                val outcome = value.getJSONObject("outcome")
                val accepted = value.getBoolean("accepted")
                proof(outcome.opt("accepted") == accepted
                    && outcome.opt("code") in setOf("APPLIED", "STALE_TARGET", "STALE_REVISION", "TERMINAL", "INVALID_PHASE", "INVALID_RANGE", "SESSION_EXISTS")
                    && accepted == (outcome.opt("code") == "APPLIED") && outcome.has("revision")
                    && (outcome.isNull("revision") || ActionJson.identity(outcome.opt("revision")))
                    && (!accepted || outcome.opt("revision") == command.opt("actionId")))
                if (accepted) {
                    val focusJson = payload.getJSONObject("focusSession")
                    // Reuse the strict boundary, retaining the original JSON.
                    CausalFocus.initial(accountId, focusJson)
                    val phase = when (command.getString("kind")) {
                        "stop" -> "stopped"
                        "pause" -> "paused"
                        "extend" -> null
                        else -> "active"
                    }
                    proof(focusJson.opt("sessionId") == command.opt("sessionId") && focusJson.opt("taskId") == command.opt("taskId")
                        && focusJson.opt("phase") in setOf("active", "paused", "stopped")
                        && (phase == null || focusJson.opt("phase") == phase))
                }
            }
            else -> {
                val counts = if (operation.getString("type") == "counter") value.getJSONObject("outcome").getJSONObject("counts")
                    else value.getJSONObject("counts")
                proof(value.getBoolean("accepted") && listOf("planViewCount", "dailyPostponeCount").all {
                    ActionJson.integer(counts.opt(it))?.let { count -> count >= 0 } == true })
                if (operation.getString("type") == "counter") {
                    val outcome = value.getJSONObject("outcome")
                    proof(outcome.opt("accepted") == true && outcome.opt("code") == "APPLIED" && outcome.opt("day") == command.opt("day"))
                } else {
                    val baseline = value.getJSONObject("baseline")
                    CounterLedger.project(baseline, JSONArray())
                    proof(baseline.opt("accountId") == accountId && baseline.opt("day") == command.opt("day"))
                }
                if (payload.opt("date") == command.opt("day")) proof(listOf("planViewCount", "dailyPostponeCount").all {
                    ActionJson.integer(payload.opt(it)) == ActionJson.integer(counts.opt(it)) })
                if (operation.getString("type") == "counterDay" && command.opt("kind") == "select") proof(payload.opt("date") == command.opt("day"))
            }
        }
        return value
    }
}
