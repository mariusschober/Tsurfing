package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject

/** Derivatives are recomputed from retained admissions. Original identities,
 * admission payloads and attempted bytes never become mutable authority. */
object NativePlanningCompletionRebase {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    private fun objects(array: JSONArray) = (0 until array.length()).map(array::getJSONObject)
    fun validateProofs(state: JSONObject) {
        val proofs = state.optJSONObject("planningResolutions") ?: JSONObject()
        for (id in proofs.keys()) {
            val proof = proofs.getJSONObject(id); val command = proof.getJSONObject("command")
            require(proof.keys().asSequence().toSet() == setOf("command", "request", "members", "snapshot")
                && command.opt("operationId") == id && command.opt("accountId") == state.opt("accountId") && proof.getString("request") == command.toString())
            NativePlanningProtocol.review(state.getString("accountId"), command, proof.getJSONObject("snapshot"))
            val members = objects(proof.getJSONArray("members"))
            require(members.isNotEmpty() && members.all { ActionJson.identity(it.opt("mutationId")) }
                && members.map { it.getString("mutationId") }.toSet().size == members.size)
        }
    }
    fun queued(value: JSONObject): SyncOutboxEntity {
        fun optional(key: String) = if (value.isNull(key)) null else value.getString(key)
        val row = SyncOutboxEntity(value.getString("mutationId"), value.getString("deviceId"), value.getString("entityType"),
            value.getString("entityId"), if (value.isNull("baseServerVersion")) null else value.getLong("baseServerVersion"),
            value.getLong("version"), value.getString("payload"), value.getString("updatedAt"), optional("deletedAt"),
            optional("dependsOnMutationId"), optional("resolvesConflictId"), optional("attemptedAt"))
        require(same(NativeLegacyReceiptEvidence.queued(row), value)) { "The retained saved edit was changed." }
        return row
    }
    fun edit(state: JSONObject, row: SyncOutboxEntity, visiting: Set<String> = emptySet()): SyncOutboxEntity {
        val proof = state.optJSONObject("planningEdits")?.optJSONObject(row.mutationId) ?: return row
        val original = queued(proof.getJSONObject("original")); val predecessor = proof.getJSONObject("predecessor")
        require(proof.keys().asSequence().toSet() == setOf("original", "predecessor") && original.mutationId == row.mutationId
            && original.attemptedAt == null && original.dependsOnMutationId == predecessor.opt("mutationId")
            && original.entityType == predecessor.opt("entityType") && original.entityId == predecessor.opt("entityId")
            && original.version > predecessor.getLong("version") && row.mutationId !in visiting) { "The saved edit has different predecessor evidence." }
        val next = visiting + row.mutationId
        val predecessorId = predecessor.getString("mutationId")
        val earlier = state.optJSONObject("planningEdits")?.optJSONObject(predecessorId)
        val replacement: JSONObject = if (earlier != null) {
            val before = queued(earlier.getJSONObject("original")); val effective = edit(state, before, next)
            require(same(JSONObject(before.payload), predecessor.getJSONObject("payload")) || same(JSONObject(effective.payload), predecessor.getJSONObject("payload")))
            JSONObject(effective.payload)
        } else {
            val admissions = state.optJSONObject("completionAdmissions") ?: JSONObject()
            val completionId = admissions.keys().asSequence().firstOrNull { id -> objects(admissions.getJSONObject(id).getJSONArray("members")).any { it.opt("mutationId") == predecessorId } }
            if (completionId != null) {
                val before = objects(admissions.getJSONObject(completionId).getJSONArray("members")).single { it.opt("mutationId") == predecessorId }
                val effective = objects(members(state, completionId, next)).single { it.opt("mutationId") == predecessorId }
                require(same(before.getJSONObject("payload"), predecessor.getJSONObject("payload")) || same(effective.getJSONObject("payload"), predecessor.getJSONObject("payload")))
                effective.getJSONObject("payload")
            } else {
                val resolutions = state.getJSONObject("planningResolutions")
                val root = resolutions.keys().asSequence().map(resolutions::getJSONObject).singleOrNull { r -> objects(r.getJSONArray("members")).any { same(it, predecessor) } }
                    ?: error("The saved edit is missing its planning resolution.")
                NativePlanningProtocol.payload(original.entityType, record(state.getString("accountId"), root, predecessor).getJSONObject("payload"))
            }
        }
        return row.copy(payload = savedEdit(original.entityType, predecessor.getJSONObject("payload"), JSONObject(original.payload), replacement).toString())
    }
    fun savedEdit(type: String, before: JSONObject, after: JSONObject, synced: JSONObject): JSONObject {
        require(type == "tasks" && before.has("id") && before.opt("id") == after.opt("id") && before.opt("id") == synced.opt("id")) {
            "This saved change needs separate review before resolving the order."
        }
        val planningFields = setOf("plannedOrder", "plannedOrderDate", "excitement", "roi", "order", "isFrog", "beforeFrog", "importance", "urgency", "priority", "energyLevel")
        val result = JSONObject(synced.toString())
        for (key in (before.keys().asSequence() + after.keys().asSequence()).toSet()) {
            if (same(before.opt(key), after.opt(key))) continue
            require(key !in planningFields) { "A later ordering change needs its own planning review." }
            // updatedAt is the timestamp of the preserved local edit; it is
            // not an independently edited user field.
            require(key == "updatedAt" || same(synced.opt(key), before.opt(key)) || same(synced.opt(key), after.opt(key))) {
                "Both devices changed $key. Your saved edit is retained for review."
            }
            require(!terminal(synced) || key !in setOf("completed", "lifecycleStatus", "deletedAt", "wontDo") || same(synced.opt(key), after.opt(key))) {
                "A saved edit cannot restore a completed or removed task."
            }
            if (after.has(key)) result.put(key, after.get(key)) else result.remove(key)
        }
        return result
    }
    fun validateEdits(state: JSONObject, rows: List<SyncOutboxEntity> = emptyList()) {
        validateProofs(state)
        val proofs = state.optJSONObject("planningEdits") ?: return
        for (id in proofs.keys()) {
            val original = queued(proofs.getJSONObject(id).getJSONObject("original")); require(original.mutationId == id)
            val effective = edit(state, original)
            rows.singleOrNull { it.mutationId == id }?.let { require(same(JSONObject(it.payload), JSONObject(effective.payload))) { "The saved edit differs from its reviewed projection." } }
        }
    }
    fun record(account: String, proof: JSONObject, source: JSONObject): JSONObject {
        val command = proof.getJSONObject("command")
        require(command.opt("accountId") == account && proof.getString("request") == command.toString())
        val snapshot = NativePlanningProtocol.review(account, command, proof.getJSONObject("snapshot"))
        val members = objects(proof.getJSONArray("members"))
        require(members.map { it.getString("mutationId") }.toSet().size == members.size && members.any { same(it, source) })
        val record = objects(snapshot.getJSONArray("records")).singleOrNull {
            it.opt("entity_type") == source.opt("entityType") && it.opt("entity_id") == source.opt("entityId")
        } ?: error("The completion predecessor is missing from the synced review.")
        require(record.isNull("deleted_at")) { "The completion predecessor was removed elsewhere." }
        return record
    }
    fun members(state: JSONObject, id: String, visiting: Set<String> = emptySet()): JSONArray {
        require(id !in visiting) { "Completion dependency cycle requires recovery." }
        val entry = state.getJSONObject("completionAdmissions").getJSONObject(id)
        val original = objects(entry.getJSONArray("members")).map { JSONObject(it.toString()) }
        val dependencies = entry.getJSONObject("dependencies")
        val task = original.singleOrNull { it.opt("entityType") == "tasks" }?.getJSONObject("payload")
        val earned = task?.optJSONObject("__goalflowCompletionUndo")?.opt("earnedXp")
        return JSONArray(original.map { member ->
            val dependency = dependencies.optJSONObject(member.getString("mutationId")) ?: return@map member
            val source = dependency.getJSONObject("request")
            val replacement = when (dependency.getString("kind")) {
                "planning" -> {
                    val proof = state.optJSONObject("planningResolutions")?.optJSONObject(dependency.getString("actionId")) ?: return@map member
                    require(proof.getJSONObject("command").opt("operationId") == dependency.opt("actionId"))
                    NativePlanningProtocol.payload(member.getString("entityType"), record(state.getString("accountId"), proof, source).getJSONObject("payload"))
                }
                "completion" -> {
                    val parent = dependency.getString("actionId")
                    val before = objects(state.getJSONObject("completionAdmissions").getJSONObject(parent).getJSONArray("members")).single { it.opt("mutationId") == source.opt("mutationId") }
                    val effective = objects(members(state, parent, visiting + id)).single { it.opt("mutationId") == source.opt("mutationId") }
                    if (same(effective, source)) return@map member
                    require(same(before, source)) { "The retained completion predecessor differs." }
                    effective.getJSONObject("payload")
                }
                "legacy" -> {
                    if (state.optJSONObject("planningEdits")?.has(source.getString("mutationId")) != true) return@map member
                    val original = queued(source); val effective = edit(state, original, visiting + id)
                    if (same(JSONObject(original.payload), JSONObject(effective.payload))) return@map member
                    JSONObject(effective.payload)
                }
                else -> return@map member
            }
            val sourcePayload = if (source.opt("payload") is String) JSONObject(source.getString("payload")) else source.getJSONObject("payload")
            if (same(replacement, sourcePayload)) return@map member
            val key = "${member.getString("entityType")}:${member.getString("entityId")}"
            require(same(JSONObject(entry.getJSONObject("preimages").getString(key)), sourcePayload)) { "Completion preimage differs from its predecessor." }
            JSONObject(member.toString()).put("payload", rebase(member.getString("entityType"), sourcePayload, member.getJSONObject("payload"), replacement, earned))
        })
    }
    private fun terminal(task: JSONObject) = task.opt("completed") == true || task.opt("wontDo") == true || !task.isNull("deletedAt")
        || task.opt("lifecycleStatus") in setOf("completed", "dropped", "archived", "broken_down")
    private fun reward(before: JSONObject, earned: Long): JSONObject {
        val result = JSONObject(before.toString())
        var level = before.optInt("level", 1).coerceIn(1, 1_000_000)
        var xp = before.optLong("xp", 0).coerceIn(0, Int.MAX_VALUE.toLong()) + earned
        var next = level.toLong() * 100
        while (xp >= next && level < 1_000_000) { xp -= next; level++; next = level.toLong() * 100 }
        return result.put("level", level).put("xp", xp).put("xpToNextLevel", next)
    }
    fun rebase(type: String, before: JSONObject, after: JSONObject, synced: JSONObject, earnedValue: Any?): JSONObject {
        if (type == "progress") {
            val earned = ActionJson.integer(earnedValue) ?: error("The original earned reward is missing.")
            require(earned in 1..Int.MAX_VALUE.toLong() && same(reward(before, earned), after)) { "The captured reward does not prove the completion balance." }
            return reward(synced, earned)
        }
        require(type == "tasks" && before.opt("id") == after.opt("id") && before.opt("id") == synced.opt("id")
            && !terminal(before) && after.opt("completed") == true && after.opt("lifecycleStatus") == "completed")
        require(!terminal(synced)) { "This task was already completed or removed elsewhere. Its completion needs review." }
        val owned = setOf("completed", "lifecycleStatus", "completedAt", "actualDuration", "flowState", "description", "updatedAt", "__goalflowCompletionUndo")
        val result = JSONObject(synced.toString())
        for (key in (before.keys().asSequence() + after.keys().asSequence()).toSet()) {
            if (same(before.opt(key), after.opt(key))) continue
            require(key in owned) { "The completion also changes unrelated task fields." }
            if (after.has(key)) result.put(key, after.get(key)) else result.remove(key)
        }
        return result
    }
}
