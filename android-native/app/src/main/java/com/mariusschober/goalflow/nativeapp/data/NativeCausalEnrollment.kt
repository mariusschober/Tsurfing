package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

object NativeCausalEnrollmentProtocol {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    fun capability(accountId: String, value: JSONObject): JSONObject {
        require(ActionJson.identity(accountId) && value.keys().asSequence().toSet() == setOf("schemaVersion", "accountId", "rolloutReady", "enrolled", "epoch", "projectionRevision")
            && ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("accountId") == accountId
            && value.opt("rolloutReady") == false && value.opt("enrolled") is Boolean
            && (if (value.getBoolean("enrolled")) ActionJson.identity(value.opt("epoch")) && ActionJson.integer(value.opt("projectionRevision"))?.let { it >= 0 } == true
                else value.isNull("epoch") && value.isNull("projectionRevision"))) { "The causal capability differs from the authenticated account." }
        return value
    }
    fun cutover(accountId: String, value: JSONObject): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("schemaVersion", "accountId", "cutoverId", "expectedTrackingServerVersion", "expectedTrackingPayload")
            && ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("accountId") == accountId
            && ActionJson.identity(value.opt("cutoverId")) && ActionJson.integer(value.opt("expectedTrackingServerVersion"))?.let { it > 0 } == true) { "Invalid causal cutover request." }
        val payload = value.getJSONObject("expectedTrackingPayload")
        CounterLedger.project(JSONObject().put("schemaVersion", 1).put("baselineId", value.getString("cutoverId"))
            .put("accountId", accountId).put("day", payload.opt("date"))
            .put("counts", JSONObject().put("planViewCount", payload.opt("planViewCount")).put("dailyPostponeCount", payload.opt("dailyPostponeCount")))
            .put("evidenceIds", JSONArray().put(value.getString("cutoverId"))), JSONArray())
        CausalFocus.initial(accountId, if (!payload.has("focusSession") || payload.isNull("focusSession")) null else payload.getJSONObject("focusSession"))
        return value
    }
    fun initialization(accountId: String, value: JSONObject): JSONObject {
        require(value.keys().asSequence().toSet() == setOf("schemaVersion", "accountId", "initializationId", "initialTracking")
            && ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("accountId") == accountId
            && ActionJson.identity(value.opt("initializationId"))) { "Invalid causal initialization request." }
        val payload = value.getJSONObject("initialTracking")
        require(ActionJson.integer(payload.opt("planViewCount")) == 0L && ActionJson.integer(payload.opt("dailyPostponeCount")) == 0L
            && (!payload.has("focusSession") || payload.isNull("focusSession"))) { "Initialization requires empty local defaults." }
        cutover(accountId, JSONObject().put("schemaVersion", 2).put("accountId", accountId).put("cutoverId", value.getString("initializationId"))
            .put("expectedTrackingServerVersion", 1).put("expectedTrackingPayload", payload))
        return value
    }
    fun cutoverReceipt(accountId: String, operation: JSONObject, receipt: JSONObject): JSONObject {
        cutover(accountId, operation)
        NativeCausalHistoryProtocol.entry(accountId, operation.getString("cutoverId"), 0,
            JSONObject().put("schemaVersion", 2).put("accountId", accountId).put("epoch", operation.getString("cutoverId"))
                .put("revision", 0).put("receipt", receipt))
        require(same(operation, receipt.opt("operation"))) { "Enrollment did not prove the exact attempted cutover." }
        return receipt
    }
    fun initializationReceipt(accountId: String, operation: JSONObject, receipt: JSONObject): JSONObject {
        initialization(accountId, operation)
        require(ActionJson.integer(receipt.opt("schemaVersion")) == 2L && receipt.opt("type") == "initialization"
            && receipt.opt("created") is Boolean && same(operation, receipt.opt("operation"))) { "Initialization did not prove the exact request." }
        val proof = receipt.getJSONObject("cutoverReceipt"); val selected = proof.getJSONObject("operation")
        cutoverReceipt(accountId, selected, proof)
        require(selected.opt("cutoverId") == operation.opt("initializationId")
            && (!receipt.getBoolean("created") || (same(selected.opt("expectedTrackingPayload"), operation.opt("initialTracking"))
                && ActionJson.integer(proof.getJSONObject("record").opt("version")) == 1L
                && proof.getJSONObject("record").opt("device_id") == "causal-initialization-v2"))) { "Initialization did not prove the selected baseline." }
        return receipt
    }
    fun validate(accountId: String, state: JSONObject) {
        val capability = if (state.has("causalCapability")) capability(accountId, state.getJSONObject("causalCapability")) else null
        require(capability == null || capability.getBoolean("enrolled")) { "Only enrolled capability evidence is retained." }
        require(!state.has("cutoverRequest") || !state.has("initializationRequest")) { "Enrollment has conflicting attempts." }
        for ((requestKey, receiptKey) in listOf("cutoverRequest" to "cutoverReceipt", "initializationRequest" to "initializationReceipt")) {
            if (!state.has(requestKey)) { require(!state.has(receiptKey)) { "The attempted enrollment request is missing." }; continue }
            val bytes = state.getString(requestKey)
            require(bytes.toByteArray(Charsets.UTF_8).size <= 4 * 1024 * 1024) { "Enrollment exceeds its preserved envelope limit." }
            val operation = JSONObject(bytes)
            val enrollmentId = operation.opt(if (requestKey == "cutoverRequest") "cutoverId" else "initializationId") as? String
            require(enrollmentId != null && listOf("focusAdmissions", "counterAdmissions", "counterDayAdmissions").none {
                state.optJSONObject(it)?.has(enrollmentId) == true }) { "Enrollment reuses a local action identity." }
            if (requestKey == "cutoverRequest") {
                cutover(accountId, operation)
                val meta = state.getJSONObject("cutover").getJSONArray("syncMeta")
                val versions = (0 until meta.length()).map { meta.getJSONObject(it) }
                    .filter { it.opt("entityType") in setOf("tracking", "tracking:singleton") }
                    .mapNotNull { ActionJson.integer(it.opt("serverVersion")) }.filter { it > 0 }.distinct()
                require(versions.size == 1 && versions.single() == operation.getLong("expectedTrackingServerVersion")) { "Cutover differs from its preserved server version." }
                require(same(JSONObject(state.getJSONObject("cutover").getJSONObject("tracking").getString("payload")), operation.getJSONObject("expectedTrackingPayload"))) { "Cutover differs from preserved local evidence." }
                if (state.has(receiptKey)) cutoverReceipt(accountId, operation, state.getJSONObject(receiptKey))
                require(capability == null || capability.opt("epoch") == operation.opt("cutoverId")) { "The discovered cutover epoch differs." }
            } else {
                initialization(accountId, operation)
                require(state.getJSONObject("cutover").isNull("tracking") && same(state.opt("localInitialization"), operation.opt("initialTracking"))) { "Initialization differs from preserved local absence." }
                if (state.has(receiptKey)) {
                    initializationReceipt(accountId, operation, state.getJSONObject(receiptKey))
                    require(capability == null || capability.opt("epoch") == operation.opt("initializationId")) { "The accepted initialization epoch differs." }
                }
            }
        }
        if (capability != null && state.has("causalHistory")) {
            val history = state.getJSONObject("causalHistory")
            require(history.opt("epoch") == capability.opt("epoch") && history.getLong("throughRevision") <= capability.getLong("projectionRevision")) { "History exceeds its discovered epoch or frontier." }
        }
    }
}

data class NativeEnrollmentAttempt(val route: String, val bytes: String, val epoch: String, val hasReceipt: Boolean)

class NativeCausalEnrollmentStore(private val database: GoalflowDatabase) {
    private suspend fun state(accountId: String): Pair<CausalAccountEntity, JSONObject> {
        require(database.localAccountDao().get()?.userId == accountId) { "Enrollment account differs from this database." }
        val entity = database.causalAccountDao().get(accountId) ?: error("Explicit causal preparation is required.")
        return entity to NativeCausalJournal.validate(entity)
    }
    private fun attempt(state: JSONObject): NativeEnrollmentAttempt? {
        if (state.has("cutoverRequest")) return NativeEnrollmentAttempt("causal-cutover", state.getString("cutoverRequest"), JSONObject(state.getString("cutoverRequest")).getString("cutoverId"), state.has("cutoverReceipt"))
        if (state.has("initializationRequest")) return NativeEnrollmentAttempt("causal-initialize", state.getString("initializationRequest"), JSONObject(state.getString("initializationRequest")).getString("initializationId"), state.has("initializationReceipt"))
        return null
    }
    suspend fun current(accountId: String): NativeEnrollmentAttempt? = database.withTransaction { attempt(state(accountId).second) }
    suspend fun prepare(accountId: String): NativeEnrollmentAttempt? = database.withTransaction {
        val (entity, state) = state(accountId)
        attempt(state)?.let { return@withTransaction it }
        require(!state.has("causalCapability")) { "Already enrolled accounts require history reconciliation." }
        val cutover = state.getJSONObject("cutover"); val id = UUID.randomUUID().toString()
        if (cutover.isNull("tracking")) {
            val operation = JSONObject().put("schemaVersion", 2).put("accountId", accountId).put("initializationId", id)
                .put("initialTracking", state.getJSONObject("localInitialization"))
            NativeCausalEnrollmentProtocol.initialization(accountId, operation)
            state.put("initializationRequest", operation.toString())
        } else {
            val meta = cutover.getJSONArray("syncMeta")
            val candidates = (0 until meta.length()).map { meta.getJSONObject(it) }
                .filter { it.opt("entityType") in setOf("tracking", "tracking:singleton") }
                .mapNotNull { ActionJson.integer(it.opt("serverVersion")) }.filter { it > 0 }.distinct()
            if (candidates.size != 1) return@withTransaction null
            val operation = JSONObject().put("schemaVersion", 2).put("accountId", accountId).put("cutoverId", id)
                .put("expectedTrackingServerVersion", candidates.single()).put("expectedTrackingPayload", JSONObject(cutover.getJSONObject("tracking").getString("payload")))
            NativeCausalEnrollmentProtocol.cutover(accountId, operation)
            state.put("cutoverRequest", operation.toString())
        }
        NativeCausalEnrollmentProtocol.validate(accountId, state)
        check(database.causalAccountDao().update(entity.copy(payload = state.toString())) == 1)
        attempt(state)
    }
    suspend fun accept(accountId: String, expected: NativeEnrollmentAttempt, supplied: JSONObject) {
        val receipt = JSONObject(supplied.toString())
        database.withTransaction {
            val (entity, state) = state(accountId); val saved = attempt(state) ?: error("The exact enrollment attempt is missing.")
            require(saved.bytes == expected.bytes && saved.route == expected.route) { "The enrollment attempt changed." }
            val key = if (saved.route == "causal-cutover") "cutoverReceipt" else "initializationReceipt"
            if (state.has(key)) require(ActionJson.canonical(state.getJSONObject(key)) == ActionJson.canonical(receipt)) { "The retained enrollment receipt is immutable." }
            state.put(key, receipt); NativeCausalEnrollmentProtocol.validate(accountId, state)
            check(database.causalAccountDao().update(entity.copy(payload = state.toString())) == 1)
        }
    }
    suspend fun bind(accountId: String, supplied: JSONObject) {
        val capability = JSONObject(supplied.toString()); NativeCausalEnrollmentProtocol.capability(accountId, capability)
        require(capability.getBoolean("enrolled")) { "The account is not enrolled." }
        database.withTransaction {
            val (entity, state) = state(accountId); val previous = state.optJSONObject("causalCapability")
            require(previous == null || (previous.opt("epoch") == capability.opt("epoch") && previous.getLong("projectionRevision") <= capability.getLong("projectionRevision"))) { "The causal epoch or revision cannot be rewound." }
            state.put("causalCapability", capability); NativeCausalEnrollmentProtocol.validate(accountId, state)
            check(database.causalAccountDao().update(entity.copy(payload = state.toString())) == 1)
        }
    }
}
