package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import org.json.JSONObject

/** An accepted receipt alone does not move the applied history frontier. A
 * pending action can disappear only when both exact request proof and its
 * applied history entry remain in this same durable account journal. */
object NativeCausalRequestJournal {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    fun appliedRevision(state: JSONObject): Long = state.optJSONObject("projectionAdmissions")?.let { entries ->
        entries.keys().asSequence().map { entries.getJSONObject(it) }.maxByOrNull { it.getLong("sequence") }?.getLong("revision")
    } ?: -1L

    fun admitted(state: JSONObject, id: String): Pair<String, JSONObject> {
        val candidates = listOf(Triple("focus", "focusAdmissions", "command"), Triple("counter", "counterAdmissions", "event"),
            Triple("counterDay", "counterDayAdmissions", "command")).filter { state.optJSONObject(it.second)?.has(id) == true }
        require(candidates.size == 1) { "The action requires one exact local admission." }
        val (type, key, field) = candidates.single(); val admission = state.getJSONObject(key).getJSONObject(id)
        require(type != "focus" || admission.getJSONObject("outcome").getBoolean("accepted")) { "A locally rejected command cannot be sent." }
        return type to admission.getJSONObject(field)
    }

    fun outbox(type: String) = when (type) {
        "focus" -> "focusOutbox"
        "counter" -> "counterOutbox"
        "counterDay" -> "counterDayOutbox"
        else -> error("Invalid causal request type.")
    }

    fun canRetire(accountId: String, state: JSONObject, id: String): Boolean {
        val receipt = state.optJSONObject("causalReceipts")?.optJSONObject(id) ?: return false
        val bytes = state.optJSONObject("causalRequests")?.getString(id) ?: return false
        val operation = NativeCausalProtocol.operation(accountId, JSONObject(bytes))
        NativeCausalProtocol.receipt(accountId, operation, receipt)
        if (!receipt.getBoolean("accepted") || receipt.getLong("projectionRevision") > appliedRevision(state)) return false
        val history = state.getJSONObject("causalHistory")
        val saved = history.getJSONObject("entries").getJSONObject(receipt.getLong("projectionRevision").toString())
        require(operation.getJSONObject("command").opt("actionId") == id && operation.opt("epoch") == history.opt("epoch")
            && same(JSONObject(saved.getString("body")).getJSONObject("receipt"), receipt)) { "The applied history differs from the retained action receipt." }
        return true
    }

    fun validate(accountId: String, state: JSONObject) {
        if (!state.has("causalRequests") && !state.has("causalReceipts")) return
        val requests = state.getJSONObject("causalRequests")
        val receipts = if (state.has("causalReceipts")) state.getJSONObject("causalReceipts") else JSONObject()
        val capability = NativeCausalEnrollmentProtocol.capability(accountId, state.getJSONObject("causalCapability"))
        require(capability.getBoolean("enrolled")) { "Requests require an enrolled account." }
        val revision = appliedRevision(state)
        require(revision >= 0) { "Requests require an applied account baseline." }
        val canonical = NativeCausalReplay.replayAt(accountId, state.getJSONObject("causalHistory"), revision)
        for (id in requests.keys()) {
            val bytes = requests.getString(id)
            require(bytes.toByteArray(Charsets.UTF_8).size <= 256 * 1024) { "The retained request exceeds its transport envelope." }
            val operation = NativeCausalProtocol.operation(accountId, JSONObject(bytes)); val (type, command) = admitted(state, id)
            require(operation.opt("epoch") == capability.opt("epoch") && operation.opt("type") == type
                && operation.getJSONObject("command").opt("actionId") == id && same(command, operation.opt("command"))) {
                "The retained request differs from its original admission or account epoch."
            }
            require(type != "counter" || canonical.baselines.has(command.getString("day"))) { "A counter request has no applied day baseline." }
            val pending = state.optJSONObject(outbox(type))?.optJSONObject(id)
            require(if (pending == null) canRetire(accountId, state, id) else same(pending, command)) {
                "The request has neither exact pending intent nor applied receipt proof."
            }
        }
        for (id in receipts.keys()) {
            val operation = NativeCausalProtocol.operation(accountId, JSONObject(requests.getString(id)))
            require(operation.getJSONObject("command").opt("actionId") == id) { "The retained receipt action differs." }
            NativeCausalProtocol.receipt(accountId, operation, receipts.getJSONObject(id))
        }
    }

    /** Called inside the same transaction as projection application, or after
     * receipt capture when its revision was already applied. */
    fun reconcile(accountId: String, state: JSONObject, canonical: NativeCausalReplayResult) {
        val requests = state.optJSONObject("causalRequests") ?: return
        val receipts = state.optJSONObject("causalReceipts") ?: JSONObject()
        for (id in receipts.keys()) {
            val receipt = receipts.getJSONObject(id)
            require(receipt.getLong("projectionRevision") <= appliedRevision(state)
                && same(receipt, canonical.receipts.opt(id))) { "Apply history through every retained receipt before acknowledging actions." }
        }
        for (id in requests.keys()) {
            val receipt = canonical.receipts.optJSONObject(id) ?: continue
            val operation = NativeCausalProtocol.operation(accountId, JSONObject(requests.getString(id)))
            NativeCausalProtocol.receipt(accountId, operation, receipt)
            require(!receipts.has(id) || same(receipts.getJSONObject(id), receipt)) { "The retained receipt is immutable." }
            receipts.put(id, receipt)
            if (receipt.getBoolean("accepted")) state.getJSONObject(outbox(operation.getString("type"))).remove(id)
        }
        state.put("causalReceipts", receipts)
    }
}

data class NativeCausalReceiptResult(val accepted: Boolean, val duplicate: Boolean, val retired: Boolean)

class NativeCausalRequestStore(private val database: GoalflowDatabase) {
    private suspend fun state(accountId: String): Pair<CausalAccountEntity, JSONObject> {
        require(database.localAccountDao().get()?.userId == accountId) { "Request account differs from this database." }
        val entity = database.causalAccountDao().get(accountId) ?: error("Causal account preparation is required.")
        return entity to NativeCausalJournal.validate(entity)
    }

    /** Original admission order supplies dependencies, never wall-clock order.
     * A retained rejection waits for resolution instead of being sent forever. */
    suspend fun nextReady(accountId: String): String? = database.withTransaction {
        val (_, state) = state(accountId)
        val revision = NativeCausalRequestJournal.appliedRevision(state)
        require(revision >= 0) { "Apply verified history before selecting an action." }
        val canonical = NativeCausalReplay.replayAt(accountId, state.getJSONObject("causalHistory"), revision)
        val candidates = mutableListOf<Pair<Long, String>>()
        for ((admissionKey, pendingKey) in listOf("focusAdmissions" to "focusOutbox", "counterAdmissions" to "counterOutbox",
            "counterDayAdmissions" to "counterDayOutbox")) {
            val pending = state.optJSONObject(pendingKey) ?: continue
            for (id in pending.keys()) {
                if (state.optJSONObject("causalReceipts")?.has(id) == true) continue
                val command = pending.getJSONObject(id)
                if (pendingKey == "counterOutbox" && !canonical.baselines.has(command.getString("day"))) continue
                if (pendingKey == "focusOutbox" && state.optJSONObject("causalProjectionReviews")?.optJSONObject(id)?.opt("code") == "TASK_REVIEW_REQUIRED") continue
                candidates.add(state.getJSONObject(admissionKey).getJSONObject(id).getLong("sequence") to id)
            }
        }
        candidates.minByOrNull { it.first }?.second
    }

    suspend fun prepare(accountId: String, actionId: String): String = database.withTransaction {
        val (entity, state) = state(accountId)
        val requests = state.optJSONObject("causalRequests") ?: JSONObject()
        if (requests.has(actionId)) return@withTransaction requests.getString(actionId)
        val capability = NativeCausalEnrollmentProtocol.capability(accountId, state.getJSONObject("causalCapability"))
        val revision = NativeCausalRequestJournal.appliedRevision(state)
        require(capability.getBoolean("enrolled") && revision >= 0) { "Apply the verified account baseline before preparing an action." }
        val (type, command) = NativeCausalRequestJournal.admitted(state, actionId)
        require(state.getJSONObject(NativeCausalRequestJournal.outbox(type)).has(actionId)) { "The action is not pending." }
        require(state.optJSONObject("causalProjectionReviews")?.optJSONObject(actionId)?.opt("code") != "TASK_REVIEW_REQUIRED") {
            "Resolve the retained task review before sending this focus command."
        }
        if (type == "counter") require(NativeCausalReplay.replayAt(accountId, state.getJSONObject("causalHistory"), revision)
            .baselines.has(command.getString("day"))) { "The counter is waiting for a verified day baseline." }
        val operation = JSONObject().put("schemaVersion", 2).put("epoch", capability.getString("epoch")).put("type", type).put("command", command)
        NativeCausalProtocol.operation(accountId, operation)
        val bytes = operation.toString()
        require(bytes.toByteArray(Charsets.UTF_8).size <= 256 * 1024) { "The action exceeds its transport envelope. Its admission remains retained." }
        requests.put(actionId, bytes); state.put("causalRequests", requests)
        NativeCausalJournal.validate(entity.copy(payload = state.toString()))
        check(database.causalAccountDao().update(entity.copy(payload = state.toString())) == 1)
        bytes
    }

    suspend fun receipt(accountId: String, actionId: String): JSONObject? = database.withTransaction {
        state(accountId).second.optJSONObject("causalReceipts")?.optJSONObject(actionId)?.let { JSONObject(it.toString()) }
    }

    suspend fun accept(accountId: String, actionId: String, supplied: JSONObject): NativeCausalReceiptResult {
        val captured = JSONObject(supplied.toString())
        return database.withTransaction {
            val (entity, state) = state(accountId)
            val operation = NativeCausalProtocol.operation(accountId, JSONObject(state.getJSONObject("causalRequests").getString(actionId)))
            require(operation.getJSONObject("command").opt("actionId") == actionId) { "The receipt action differs from its retained request." }
            NativeCausalProtocol.receipt(accountId, operation, captured)
            val receipts = state.optJSONObject("causalReceipts") ?: JSONObject()
            val prior = receipts.optJSONObject(actionId)
            require(prior == null || ActionJson.canonical(prior) == ActionJson.canonical(captured)) { "The retained receipt is immutable." }
            receipts.put(actionId, captured); state.put("causalReceipts", receipts)
            // A receipt newer than the applied basis remains pending. Capturing
            // it cannot borrow its tracking server_version as an ordinary cursor.
            if (captured.getLong("projectionRevision") <= NativeCausalRequestJournal.appliedRevision(state)) {
                val canonical = NativeCausalReplay.replayAt(accountId, state.getJSONObject("causalHistory"), NativeCausalRequestJournal.appliedRevision(state))
                val saved = canonical.receipts.optJSONObject(actionId)
                require(ActionJson.canonical(saved) == ActionJson.canonical(captured)) { "The applied history differs from this receipt." }
                if (captured.getBoolean("accepted")) state.getJSONObject(NativeCausalRequestJournal.outbox(operation.getString("type"))).remove(actionId)
            }
            val updated = entity.copy(payload = state.toString()); NativeCausalJournal.validate(updated)
            check(database.causalAccountDao().update(updated) == 1)
            NativeCausalReceiptResult(captured.getBoolean("accepted"), prior != null,
                !state.getJSONObject(NativeCausalRequestJournal.outbox(operation.getString("type"))).has(actionId))
        }
    }
}
