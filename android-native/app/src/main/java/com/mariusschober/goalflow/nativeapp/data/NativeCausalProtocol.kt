package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/** Version-two action receipts are separate from legacy snapshot acceptance.
 * Validation returns the original object and never normalizes its evidence. */
object NativeCausalProtocol {
    private fun positive(value: Any?) = ActionJson.integer(value)?.let { it > 0 } == true
    private fun instant(value: Any?): Instant? = (value as? String)?.let { runCatching { Instant.parse(it) }.getOrNull() }

    fun completion(accountId: String, value: JSONObject): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("schemaVersion", "epoch", "type", "command", "changes")
            && ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("type") == "completion"
            && ActionJson.identity(value.opt("epoch")) && ActionJson.identity(accountId)) { "Invalid atomic completion." }
        val command = value.getJSONObject("command")
        CausalFocus.validate(command)
        require(command.opt("accountId") == accountId && command.opt("kind") == "complete") { "Invalid completion target." }
        val changes = value.getJSONArray("changes")
        require(changes.length() in 1..6) { "Invalid completion member count." }
        val identities = mutableSetOf<String>(); val kinds = mutableSetOf<String>()
        for (index in 0 until changes.length()) {
            val change = changes.getJSONObject(index)
            val allowed = setOf("mutationId", "deviceId", "entityType", "entityId", "baseServerVersion", "version", "payload", "updatedAt", "deletedAt", "resolvesConflictId")
            val id = change.opt("mutationId"); val device = change.opt("deviceId"); val type = change.opt("entityType"); val entity = change.opt("entityId")
            require(change.keys().asSequence().all { it in allowed } && ActionJson.identity(id)
                && id != command.opt("actionId") && identities.add(id as String)
                && device is String && device.length in 1..128 && entity is String && entity.length in 1..240
                && type in setOf("tasks", "stats", "progress", "goals", "habits", "task_events") && kinds.add(type as String)
                && change.has("baseServerVersion") && (change.isNull("baseServerVersion") || ActionJson.integer(change.opt("baseServerVersion"))?.let { it >= 0 } == true)
                && ActionJson.integer(change.opt("version"))?.let { it in 1..2147483647L } == true
                && instant(change.opt("updatedAt")) != null && change.has("deletedAt") && change.isNull("deletedAt")
                && (!change.has("resolvesConflictId") || change.isNull("resolvesConflictId"))) { "Invalid completion member." }
            val payload = change.getJSONObject("payload")
            when (type) {
                "tasks" -> require(entity == command.opt("taskId") && payload.opt("id") == entity
                    && payload.opt("completed") == true && payload.opt("lifecycleStatus") == "completed"
                    && (!payload.has("deletedAt") || payload.isNull("deletedAt"))) { "Invalid completed task." }
                "stats", "progress" -> require(entity == "singleton") { "Invalid completion effect identity." }
                "task_events" -> require((payload.opt("taskId").takeUnless { it == null || it == JSONObject.NULL } ?: payload.opt("task_id")) == command.opt("taskId")
                    && (payload.opt("eventType").takeUnless { it == null || it == JSONObject.NULL } ?: payload.opt("event_type")) == "completed") { "Invalid completion event." }
            }
        }
        require("tasks" in kinds) { "Completion requires its final task payload." }
        return value
    }

    fun completionReceipt(accountId: String, operation: JSONObject, value: JSONObject): JSONObject {
        completion(accountId, operation)
        require(ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("epoch") == operation.opt("epoch")
            && positive(value.opt("projectionRevision")) && ActionJson.canonical(value.opt("operation")) == ActionJson.canonical(operation)
            && value.opt("accepted") is Boolean) { "Invalid atomic completion receipt." }
        val command = operation.getJSONObject("command"); val outcome = value.getJSONObject("outcome")
        val accepted = value.getBoolean("accepted")
        require(outcome.opt("accepted") == accepted && outcome.opt("code") in setOf("APPLIED", "STALE_TARGET", "STALE_REVISION", "TERMINAL", "INVALID_PHASE", "INVALID_RANGE", "SESSION_EXISTS")
            && accepted == (outcome.opt("code") == "APPLIED") && outcome.has("revision")
            && (outcome.isNull("revision") || ActionJson.identity(outcome.opt("revision")))
            && (!accepted || outcome.opt("revision") == command.opt("actionId"))) { "Invalid completion outcome." }
        val record = value.getJSONObject("record"); val payload = record.getJSONObject("payload")
        require(record.opt("user_id") == accountId && record.opt("entity_type") == "tracking" && record.opt("entity_id") == "singleton"
            && positive(record.opt("version")) && positive(record.opt("server_version")) && record.opt("device_id") is String
            && record.getString("device_id").isNotEmpty() && instant(record.opt("updated_at")) != null
            && record.has("deleted_at") && record.isNull("deleted_at")) { "Invalid completion tracking record." }
        val results = value.getJSONArray("changes")
        if (!accepted) { require(results.length() == 0) { "Rejected completion has accepted members." }; return value }
        val focus = payload.getJSONObject("focusSession"); CausalFocus.initial(accountId, focus)
        val changes = operation.getJSONArray("changes")
        require(focus.opt("phase") == "completed" && focus.opt("sessionId") == command.opt("sessionId")
            && focus.opt("taskId") == command.opt("taskId") && results.length() == changes.length()) { "Incomplete atomic completion receipt." }
        var previous = 0L
        for (index in 0 until changes.length()) {
            val change = changes.getJSONObject(index); val result = results.getJSONObject(index); val item = result.getJSONObject("record")
            val version = ActionJson.integer(result.opt("serverVersion")) ?: error("Invalid member revision.")
            require(result.opt("mutationId") == change.opt("mutationId") && result.opt("accepted") == true
                && version > previous && version < record.getLong("server_version")
                && (change.isNull("baseServerVersion") || change.getLong("baseServerVersion") < version)
                && result.opt("replayMismatch") != true && result.opt("serverMissing") != true && !result.has("conflictId")
                && item.opt("user_id") == accountId && item.opt("entity_type") == change.opt("entityType")
                && item.opt("entity_id") == change.opt("entityId") && item.opt("device_id") == change.opt("deviceId")
                && ActionJson.integer(item.opt("version")) == ActionJson.integer(change.opt("version"))
                && ActionJson.integer(item.opt("server_version")) == version
                && ActionJson.canonical(item.opt("payload")) == ActionJson.canonical(change.opt("payload"))
                && item.has("deleted_at") && item.isNull("deleted_at")
                && instant(item.opt("updated_at"))?.toEpochMilli() == instant(change.opt("updatedAt"))?.toEpochMilli()) { "Completion member receipt differs from the exact submitted change." }
            previous = version
        }
        return value
    }

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
