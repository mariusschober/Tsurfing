package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.time.ZoneId
import java.time.Instant

data class NativeCompletionDetails(val day: String, val timeZone: String, val actualDuration: Int? = null,
    val flowState: String? = null, val finalDescription: String? = null) {
    fun json(): JSONObject {
        require(ActionJson.day(day) && timeZone.matches(Regex("^[A-Za-z0-9_+./-]{1,128}$"))
            && (actualDuration == null || actualDuration >= 0)
            && (flowState == null || flowState in setOf("distracted", "good", "high", "flow"))) { "Invalid completion details. Nothing was completed." }
        ZoneId.of(timeZone)
        return JSONObject().put("day", day).put("timeZone", timeZone).put("actualDuration", actualDuration ?: JSONObject.NULL)
            .put("flowState", flowState ?: JSONObject.NULL).put("finalDescription", finalDescription ?: JSONObject.NULL)
    }
}

/** Completion members keep their original IDs outside the ordinary outbox.
 * Their immutable admission is also the predecessor of subsequent edits. */
object NativeCompletionAdmissionEvidence {
    const val MAX_BYTES = 4 * 1024 * 1024
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    fun member(row: SyncOutboxEntity): JSONObject = JSONObject().put("mutationId", row.mutationId).put("deviceId", row.deviceId)
        .put("entityType", row.entityType).put("entityId", row.entityId).put("baseServerVersion", row.baseServerVersion ?: JSONObject.NULL)
        .put("version", row.version).put("payload", JSONObject(row.payload)).put("updatedAt", row.updatedAt)
        .put("deletedAt", row.deletedAt ?: JSONObject.NULL)

    fun reserved(state: JSONObject, type: String, entityId: String): Pair<String, JSONObject>? {
        val entries = state.optJSONObject("completionAdmissions") ?: return null
        val candidates = mutableListOf<Pair<String, JSONObject>>()
        for (id in entries.keys()) if (state.getJSONObject("focusOutbox").has(id)) {
            val members = NativePlanningCompletionRebase.members(state, id)
            for (index in 0 until members.length()) {
                val member = members.getJSONObject(index)
                if (member.opt("entityType") == type && member.opt("entityId") == entityId) candidates.add(id to member)
            }
        }
        require(candidates.map { it.second.getLong("version") }.toSet().size == candidates.size) { "Ambiguous completion predecessor versions." }
        return candidates.maxByOrNull { it.second.getLong("version") }
    }

    fun operation(state: JSONObject, id: String): JSONObject = JSONObject().put("schemaVersion", 2).put("type", "completion")
        .put("epoch", state.getJSONObject("completionAdmissions").getJSONObject(id).getString("epoch"))
        .put("command", state.getJSONObject("focusAdmissions").getJSONObject(id).getJSONObject("command"))
        .put("changes", state.getJSONObject("completionAdmissions").getJSONObject(id).getJSONArray("members"))

    fun validate(accountId: String, state: JSONObject) {
        NativePlanningCompletionRebase.validateEdits(state)
        val entries = state.optJSONObject("completionAdmissions") ?: JSONObject()
        val focus = state.getJSONObject("focusAdmissions")
        val identities = mutableSetOf<String>()
        for (id in focus.keys()) require((focus.getJSONObject(id).getJSONObject("command").opt("kind") == "complete") == entries.has(id)) {
            "A completion requires its original business admission."
        }
        for (id in entries.keys()) {
            val entry = entries.getJSONObject(id); val admission = focus.getJSONObject(id)
            require(entry.keys().asSequence().toSet() == setOf("details", "epoch", "members", "dependencies", "preimages")) { "Invalid completion admission." }
            val details = entry.getJSONObject("details")
            require(details.keys().asSequence().toSet() == setOf("day", "timeZone", "actualDuration", "flowState", "finalDescription")
                && (details.isNull("actualDuration") || ActionJson.integer(details.opt("actualDuration"))?.let { it in 0..Int.MAX_VALUE.toLong() } == true)
                && (details.isNull("flowState") || details.opt("flowState") is String)
                && (details.isNull("finalDescription") || details.opt("finalDescription") is String)) { "Invalid retained completion details." }
            NativeCompletionDetails(details.getString("day"), details.getString("timeZone"),
                if (details.isNull("actualDuration")) null else details.getInt("actualDuration"),
                if (details.isNull("flowState")) null else details.getString("flowState"),
                if (details.isNull("finalDescription")) null else details.getString("finalDescription")).json()
            val capability = NativeCausalEnrollmentProtocol.capability(accountId, state.getJSONObject("causalCapability"))
            require(capability.getBoolean("enrolled") && entry.opt("epoch") == capability.opt("epoch")) { "Completion epoch differs." }
            val members = entry.getJSONArray("members"); val dependencies = entry.getJSONObject("dependencies"); val preimages = entry.getJSONObject("preimages")
            if (!admission.getJSONObject("outcome").getBoolean("accepted")) {
                require(members.length() == 0 && dependencies.length() == 0 && preimages.length() == 0) { "Rejected completion has business effects." }
                continue
            }
            val operation = NativeCausalProtocol.completion(accountId, operation(state, id))
            val taskId = admission.getJSONObject("command").getString("taskId")
            val originalTask = JSONObject(preimages.getString("tasks:$taskId"))
            val expectedTypes = mutableSetOf("tasks", "stats", "progress", "task_events")
            for ((field, type) in listOf("goalId" to "goals", "habitId" to "habits")) if (!originalTask.isNull(field)) {
                val entityId = originalTask.getString(field); expectedTypes.add(type)
                require((0 until members.length()).any {
                    val member = members.getJSONObject(it); member.opt("entityType") == type && member.opt("entityId") == entityId
                }) { "A linked completion effect is missing." }
            }
            require((0 until members.length()).map { members.getJSONObject(it).getString("entityType") }.toSet() == expectedTypes) {
                "The required completion effects are incomplete."
            }
            val maximum = JSONObject(operation.toString()); val keys = mutableSetOf<String>(); val memberIds = mutableSetOf<String>()
            for (index in 0 until members.length()) {
                val member = members.getJSONObject(index); val mutationId = member.getString("mutationId")
                require(identities.add(mutationId) && !focus.has(mutationId)
                    && state.optJSONObject("counterAdmissions")?.has(mutationId) != true
                    && state.optJSONObject("counterDayAdmissions")?.has(mutationId) != true
                    && member.opt("updatedAt") == admission.getJSONObject("command").opt("capturedAt")) { "Completion member identity or timestamp differs." }
                memberIds.add(mutationId)
                val key = member.getString("entityType") + ":" + member.getString("entityId"); keys.add(key)
                require(preimages.has(key) && (preimages.isNull(key) || preimages.opt(key) is String)) { "Completion preimage is missing." }
                if (member.getString("entityType") == "tasks") {
                    val payload = member.getJSONObject("payload"); val before = JSONObject(preimages.getString(key))
                    val notes = if (details.isNull("finalDescription")) before.getString("description") else details.getString("finalDescription")
                    require(payload.opt("description") == notes
                        && ActionJson.integer(payload.opt("completedAt")) == Instant.parse(admission.getJSONObject("command").getString("capturedAt")).toEpochMilli()) {
                        "The completion task differs from its captured final details."
                    }
                }
                if (dependencies.has(mutationId)) {
                    val dependency = dependencies.getJSONObject(mutationId); val predecessor = dependency.getJSONObject("request")
                    require(dependency.opt("kind") in setOf("legacy", "completion", "planning")
                        && ActionJson.identity(predecessor.opt("mutationId")) && predecessor.opt("mutationId") != mutationId
                        && predecessor.opt("entityType") == member.opt("entityType") && predecessor.opt("entityId") == member.opt("entityId")
                        && ActionJson.integer(predecessor.opt("version"))?.let { it > 0 && it < member.getLong("version") } == true
                        && member.isNull("baseServerVersion") && predecessor.has("deletedAt") && predecessor.isNull("deletedAt")
                        && (!predecessor.has("resolvesConflictId") || predecessor.isNull("resolvesConflictId"))) { "Invalid completion predecessor." }
                    if (dependency.opt("kind") == "completion") {
                        val parent = entries.getJSONObject(dependency.getString("actionId")).getJSONArray("members")
                        require((0 until parent.length()).any { same(parent.getJSONObject(it), predecessor) } ||
                            NativePlanningCompletionRebase.members(state, dependency.getString("actionId")).let { derived -> (0 until derived.length()).any { same(derived.getJSONObject(it), predecessor) } }) { "Completion predecessor differs from its admission." }
                    }
                }
                maximum.getJSONArray("changes").getJSONObject(index).put("baseServerVersion", ActionJson.MAX_SAFE_INTEGER)
            }
            NativePlanningCompletionRebase.members(state, id)
            require(dependencies.keys().asSequence().all { it in memberIds } && preimages.keys().asSequence().toSet() == keys
                && maximum.toString().toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "Incomplete or oversized completion admission." }
        }
    }
}
