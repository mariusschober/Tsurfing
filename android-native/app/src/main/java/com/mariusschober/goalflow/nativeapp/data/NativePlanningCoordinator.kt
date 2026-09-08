package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.time.GoalflowTimeProvider
import kotlinx.coroutines.flow.combine
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class NativePlanningSnapshot(val policy: JSONObject, val draft: JSONObject?, val pending: Int, val cost: Int, val review: JSONObject? = null, val otherDates: List<String> = emptyList()) {
    val locked get() = !policy.isNull("revision")
    val remaining get() = maxOf(0, 3 - policy.getInt("acceptedReplans"))
    fun confirmationCost(order: List<String>): Int {
        val confirmed = policy.getJSONArray("confirmedOrder")
        return if (locked && DeliberatePlanning.changed((0 until confirmed.length()).map(confirmed::getString), order)) cost else 0
    }
    val staleDraft get() = draft != null && ActionJson.canonical(draft.opt("baselineRevision")) != ActionJson.canonical(policy.opt("revision"))
}

/** Owns durable private drafts and atomic provisional confirmations. It never
 * enrolls an account into the separate focus/counter protocol. */
class NativePlanningCoordinator(
    private val database: GoalflowDatabase,
    private val time: GoalflowTimeProvider,
    private val account: suspend () -> String,
    private val queue: suspend (String) -> List<GoalflowTask>,
    private val applyProjection: suspend (JSONObject, DeliberatePlanning.Reply) -> List<SyncOutboxEntity>,
    private val readBusiness: suspend (String, String) -> JSONObject?,
    private val applyBusiness: suspend (NativeRemoteRecord, JSONObject?) -> Unit
) {
    private val dao = database.planningAccountDao()
    private val outbox = database.syncOutboxDao()
    private val raw = database.rawCollectionDao()
    private fun objects(value: JSONArray): List<JSONObject> = (0 until value.length()).map { value.getJSONObject(it) }
    private fun entries(value: JSONObject): List<JSONObject> = value.keys().asSequence().map { value.getJSONObject(it) }.toList()
    private suspend fun state(id: String): JSONObject {
        val saved = dao.get(id)
        if (saved != null) {
            val state = JSONObject(saved.payload)
            require(state.opt("schemaVersion") == 1 && state.opt("accountKey") == id && state.getLong("generation") == saved.generation) { "Planning journal needs recovery." }
            require(state.getJSONObject("planning").opt("schemaVersion") == 1) { "Update required for planning history." }
            return state
        }
        return JSONObject().put("schemaVersion", 1).put("accountKey", id).put("generation", 0)
            .put("planning", JSONObject().put("schemaVersion", 1).put("days", JSONObject()).put("drafts", JSONObject())
                .put("pending", JSONObject()).put("receipts", JSONObject()))
    }
    private suspend fun save(id: String, state: JSONObject) {
        require(account() == id) { "Planning account changed before commit." }
        val next = state.getLong("generation") + 1
        require(next in 1..ActionJson.MAX_SAFE_INTEGER)
        state.put("generation", next); dao.put(PlanningAccountEntity(id, next, state.toString()))
    }
    private suspend fun policy(state: JSONObject, id: String, day: String): JSONObject {
        val days = state.getJSONObject("planning").getJSONObject("days")
        days.optJSONObject(day)?.let { return it }
        val legacy = database.dailyPlanDao().get(day)?.let { JSONObject().put("confirmedAt", it.confirmedAt).put("taskIds", JSONArray(it.taskIds)) }
        return DeliberatePlanning.initial(id, day, legacy).also { days.put(day, it) }
    }
    private suspend fun setting(): String = raw.get("settings")?.let { JSONObject(it.payload).optString("penaltyMode", "off") } ?: "off"
    suspend fun read(day: String): NativePlanningSnapshot = database.withTransaction {
        val id = account(); val state = state(id); val planning = state.getJSONObject("planning"); val policy = policy(state, id, day)
        NativePlanningSnapshot(policy, planning.getJSONObject("drafts").optJSONObject(day),
            entries(planning.getJSONObject("pending")).count { it.getJSONObject("command").getString("localDate") == day },
            DeliberatePlanning.nextCost(policy, setting()),
            entries(planning.getJSONObject("pending")).firstOrNull { it.getJSONObject("command").opt("localDate") == day && it.has("review") },
            (planning.getJSONObject("drafts").keys().asSequence().toList() + entries(planning.getJSONObject("pending")).map { it.getJSONObject("command").getString("localDate") }).distinct().filter { it != day }.sorted())
    }
    fun observe(day: String) = combine(dao.observeChanges(), database.dailyPlanDao().observe(day), database.taskDao().observeAll(), raw.observe("settings")) { _, _, _, _ -> read(day) }
    fun currentDay(): String = time.today().toString()
    suspend fun commitDay(id: String, day: String, response: JSONObject): Boolean {
        NativePlanningProtocol.day(id, day, response)
        return database.withTransaction {
            require(account() == id) { "Planning account changed before commit." }
            val state = state(id); val planning = state.getJSONObject("planning")
            if (entries(planning.getJSONObject("pending")).any { it.getJSONObject("command").getString("localDate") == day }) return@withTransaction false
            val cursor = database.syncMetaDao().get("_cursor")?.cursor ?: 0L
            val records = response.optJSONArray("records") ?: JSONArray()
            if (objects(records).any { it.getLong("server_version") > cursor }) return@withTransaction false
            val previousHistory = planning.getJSONObject("days").optJSONObject(day)?.getJSONArray("history")
            val incomingHistory = response.getJSONObject("policy").getJSONArray("history")
            if (previousHistory != null && (previousHistory.length() > incomingHistory.length() ||
                (0 until previousHistory.length()).any { ActionJson.canonical(previousHistory.get(it)) != ActionJson.canonical(incomingHistory.get(it)) })) return@withTransaction false
            planning.getJSONObject("days").put(day, response.getJSONObject("policy"))
            save(id, state)
            true
        }
    }
    suspend fun reviewDraft(day: String): JSONObject = database.withTransaction {
        val id = account(); val state = state(id); val planning = state.getJSONObject("planning")
        val draft = planning.getJSONObject("drafts").getJSONObject(day)
        val current = policy(state, id, day)
        draft.put("baselineRevision", current.get("revision"))
            .put("maximumAcceptedXp", DeliberatePlanning.nextCost(current, setting()))
            .put("updatedAt", ActionJson.instantFormatter.format(time.now()))
        save(id, state)
        draft
    }
    suspend fun begin(day: String): JSONObject = database.withTransaction {
        val id = account(); val state = state(id); val planning = state.getJSONObject("planning"); val drafts = planning.getJSONObject("drafts")
        require(entries(planning.getJSONObject("pending")).none { it.getJSONObject("command").opt("localDate") == day && it.has("review") }) { "Resolve the saved order conflict before editing." }
        drafts.optJSONObject(day)?.let { return@withTransaction it }
        val policy = policy(state, id, day)
        val draft = JSONObject().put("schemaVersion", 1).put("accountId", id).put("localDate", day)
            .put("baselineRevision", policy.get("revision")).put("proposedOrder", JSONArray(queue(day).map { it.id }))
            .put("ratings", JSONArray()).put("priorityChanges", JSONArray()).put("maximumAcceptedXp", DeliberatePlanning.nextCost(policy, setting()))
            .put("updatedAt", ActionJson.instantFormatter.format(time.now()))
        drafts.put(day, draft); save(id, state); draft
    }
    suspend fun setOrder(day: String, order: List<String>) = database.withTransaction {
        begin(day)
        val id = account(); val state = state(id); val draft = state.getJSONObject("planning").getJSONObject("drafts").getJSONObject(day)
        val available = queue(day).map { it.id }
        require(order.size == available.size && order.toSet() == available.toSet()) { "The queue changed. Review the draft again." }
        draft.put("proposedOrder", JSONArray(order)).put("updatedAt", ActionJson.instantFormatter.format(time.now())); save(id, state)
    }
    suspend fun promote(day: String, taskId: String) = database.withTransaction {
        begin(day)
        val id = account(); val state = state(id); val draft = state.getJSONObject("planning").getJSONObject("drafts").getJSONObject(day)
        require(queue(day).any { it.id == taskId })
        val changes = objects(draft.getJSONArray("priorityChanges")).filter { it.getString("taskId") != taskId }
        draft.put("priorityChanges", JSONArray(changes).put(JSONObject().put("taskId", taskId).put("isFrog", true)))
        save(id, state)
    }
    suspend fun discard(day: String) = database.withTransaction {
        val id = account(); val state = state(id); state.getJSONObject("planning").getJSONObject("drafts").remove(day); save(id, state)
    }
    suspend fun confirm(day: String, displayedOrder: List<String>, maximumAcceptedXp: Int): DeliberatePlanning.Reply = database.withTransaction {
        val id = account(); val state = state(id); val planning = state.getJSONObject("planning"); val policy = policy(state, id, day)
        require(entries(planning.getJSONObject("pending")).none { it.getJSONObject("command").opt("localDate") == day && it.has("review") }) { "Resolve the saved order conflict before confirming." }
        val draft = planning.getJSONObject("drafts").optJSONObject(day)
        val captured = draft?.let { JSONObject(it.toString()).apply { remove("updatedAt") } }
            ?: JSONObject().put("schemaVersion", 1).put("accountId", id).put("localDate", day).put("baselineRevision", policy.get("revision"))
                .put("proposedOrder", JSONArray(displayedOrder)).put("ratings", JSONArray()).put("priorityChanges", JSONArray())
        captured.put("operationId", UUID.randomUUID().toString()).put("maximumAcceptedXp", maximumAcceptedXp)
            .put("capturedAt", ActionJson.instantFormatter.format(time.now()))
        val available = queue(day).map { DeliberatePlanning.Task(it.id, if (it.beforeFrog && it.habitId != null) 0 else if (it.isFrog) 1 else 2) }
        val progress = raw.get("progress")?.let { JSONObject(it.payload) } ?: JSONObject().put("xp", 0).put("level", 1).put("xpToNextLevel", 100)
        val result = DeliberatePlanning.apply(policy, captured, available, progress.getLong("xp"), setting())
        planning.getJSONObject("days").put(day, result.policy)
        if (result.receipt.getString("code") == "APPLIED") {
            val ordinary = JSONArray(outbox.getAll().map { it.mutationId })
            val causal = database.causalAccountDao().get(id)?.let { JSONObject(it.payload) }
            val dependencies = JSONArray()
            for (key in listOf("focusOutbox", "counterOutbox", "counterDayOutbox")) causal?.optJSONObject(key)?.keys()?.forEach { dependencies.put(it) }
            val members = applyProjection(captured, result)
            val pending = JSONObject().put("command", captured).put("provisional", result.receipt).put("sequence", state.getLong("generation") + 1)
                .put("ordinaryDependencies", ordinary).put("causalDependencies", dependencies)
                .put("members", JSONArray(members.map(NativeCompletionAdmissionEvidence::member)))
            planning.getJSONObject("pending").put(captured.getString("operationId"), pending)
            planning.getJSONObject("drafts").remove(day)
        }
        save(id, state); result
    }
    suspend fun reservation(type: String, entityId: String): Pair<String, JSONObject>? {
        val candidates = mutableListOf<Pair<String, JSONObject>>()
        for (account in dao.getAll()) {
            val pending = JSONObject(account.payload).getJSONObject("planning").getJSONObject("pending")
            for (item in entries(pending)) for (member in objects(item.getJSONArray("members"))) {
                if (member.opt("entityType") == type && member.opt("entityId") == entityId) candidates.add(item.getJSONObject("command").getString("operationId") to member)
            }
        }
        return candidates.maxByOrNull { it.second.getLong("version") }
    }

    suspend fun retainOrdinaryResults(batch: List<SyncOutboxEntity>, results: List<NativePushResult>) {
        val id = account(); val saved = dao.get(id) ?: return
        val state = state(id); val planning = state.getJSONObject("planning")
        val required = entries(planning.getJSONObject("pending")).flatMap { item -> item.getJSONArray("ordinaryDependencies").let { values -> (0 until values.length()).map(values::getString) } }.toSet()
        val receipts = planning.optJSONObject("ordinaryReceipts") ?: JSONObject()
        var changed = false
        for (result in results) if (result.mutationId in required) {
            val request = batch.single { it.mutationId == result.mutationId }
            val evidence = JSONObject().put("request", NativeLegacyReceiptEvidence.queued(request)).put("accepted", result.accepted)
                .put("serverVersion", result.serverVersion).put("receipt", result.receiptJson ?: JSONObject.NULL)
            receipts.optJSONObject(result.mutationId)?.let { require(ActionJson.canonical(it) == ActionJson.canonical(evidence)) { "Planning dependency receipt changed." } }
            receipts.put(result.mutationId, evidence); changed = true
        }
        if (changed) { planning.put("ordinaryReceipts", receipts); save(id, state) }
    }

    suspend fun reviewRequest(userId: String): String? = database.withTransaction {
        require(account() == userId)
        val pending = entries(state(userId).getJSONObject("planning").getJSONObject("pending")).minByOrNull { it.getLong("sequence") }
        if (pending?.has("review") != true || pending.optJSONArray("reviewSnapshots")?.length()?.let { it > 0 } == true) return@withTransaction null
        pending.getString("request")
    }
    suspend fun resolveReview(day: String, useDraft: Boolean) = database.withTransaction {
        val id = account(); val state = state(id); val planning = state.getJSONObject("planning")
        val pending = entries(planning.getJSONObject("pending")).firstOrNull { it.getJSONObject("command").opt("localDate") == day && it.has("review") }
            ?: error("The saved order review is no longer pending.")
        val command = pending.getJSONObject("command"); val operationId = command.getString("operationId")
        val snapshots = pending.optJSONArray("reviewSnapshots") ?: error("Wait for the complete synced order before choosing.")
        require(snapshots.length() > 0)
        val snapshot = NativePlanningProtocol.review(id, command, snapshots.getJSONObject(snapshots.length() - 1))
        require(pending.getString("request") == command.toString() && ActionJson.canonical(pending.getJSONObject("response")) == ActionJson.canonical(snapshot.getJSONObject("response")))
        require(!useDraft || !planning.getJSONObject("drafts").has(day)) { "Resume or discard the later draft first." }
        val records = objects(snapshot.getJSONArray("records"))
        val missing = snapshot.getJSONArray("missingTaskIds").let { values -> (0 until values.length()).map(values::getString).toSet() }
        val causalEntity = database.causalAccountDao().get(id)
        val causal = causalEntity?.let { JSONObject(it.payload) }
        val beforeRows = outbox.getAll()
        val beforeCompletions = mutableMapOf<String, List<JSONObject>>()
        val afterCompletions = mutableMapOf<String, List<JSONObject>>()
        if (causal != null) {
            NativeCompletionAdmissionEvidence.validate(id, causal)
            val completions = causal.optJSONObject("completionAdmissions") ?: JSONObject()
            for (completionId in completions.keys()) if (causal.getJSONObject("focusOutbox").has(completionId)) {
                beforeCompletions[completionId] = objects(NativePlanningCompletionRebase.members(causal, completionId))
            }
        }
        val graph = planning.optJSONObject("rebase")?.let { JSONObject(it.toString()) }
            ?: JSONObject().put("accountId", id).put("planningResolutions", JSONObject()).put("planningEdits", JSONObject()).put("completionAdmissions", JSONObject())
        if (causal != null) for (field in listOf("planningResolutions", "planningEdits", "completionAdmissions")) {
            val source = causal.optJSONObject(field) ?: continue
            val target = graph.getJSONObject(field)
            for (key in source.keys()) {
                require(!target.has(key) || ActionJson.canonical(target.get(key)) == ActionJson.canonical(source.get(key)))
                target.put(key, JSONObject(source.getJSONObject(key).toString()))
            }
        }
        val proofs = graph.getJSONObject("planningResolutions")
        require(!proofs.has(operationId))
        proofs.put(operationId, JSONObject().put("command", command).put("request", pending.getString("request"))
            .put("members", pending.getJSONArray("members")).put("snapshot", snapshot))
        val edits = graph.getJSONObject("planningEdits")
        val roots = objects(pending.getJSONArray("members"))
        val sources = roots + beforeRows.map(NativeCompletionAdmissionEvidence::member) + beforeCompletions.values.flatten()
        for (row in beforeRows) {
            if (roots.none { it.opt("entityType") == row.entityType && it.opt("entityId") == row.entityId && it.getLong("version") < row.version }) continue
            require(row.attemptedAt == null && !edits.has(row.mutationId)) { "An attempted or previously reviewed edit needs separate reconciliation." }
            val predecessor = sources.singleOrNull { it.opt("mutationId") == row.dependsOnMutationId }
                ?: error("The saved edit is missing its original predecessor.")
            edits.put(row.mutationId, JSONObject().put("original", NativeLegacyReceiptEvidence.queued(row)).put("predecessor", predecessor))
        }
        NativePlanningCompletionRebase.validateEdits(graph)
        val afterRows = beforeRows.map { NativePlanningCompletionRebase.edit(graph, it) }
        for (row in afterRows) outbox.insert(row)
        planning.put("rebase", graph)
        if (causal != null) {
            causal.put("planningResolutions", JSONObject(proofs.toString())).put("planningEdits", JSONObject(edits.toString()))
            for (completionId in beforeCompletions.keys) {
                val after = objects(NativePlanningCompletionRebase.members(causal, completionId))
                require(ActionJson.canonical(JSONArray(after)) == ActionJson.canonical(JSONArray(beforeCompletions[completionId]))
                    || causal.optJSONObject("causalRequests")?.has(completionId) != true) { "An attempted completion cannot be rewritten by order resolution." }
                afterCompletions[completionId] = after
            }
        }
        for (member in objects(pending.getJSONArray("members"))) {
            val type = member.getString("entityType"); val entityId = member.getString("entityId"); val version = member.getLong("version")
            require((reservation(type, entityId)?.second?.getLong("version") ?: 0) <= version) {
                "Later saved actions need reconciliation. Both orders and your changes remain saved."
            }
            val latest = (beforeRows.map(NativeCompletionAdmissionEvidence::member) + beforeCompletions.values.flatten()).filter { it.opt("entityType") == type && it.opt("entityId") == entityId && it.getLong("version") > version }.maxByOrNull { it.getLong("version") }
            val current = readBusiness(type, entityId)
            require(current != null && ActionJson.canonical(current) == ActionJson.canonical(NativePlanningProtocol.payload(type, (latest ?: member).getJSONObject("payload")))) { "Later saved edits need reconciliation. Your changes remain saved." }
            val remote = records.find { it.opt("entity_type") == type && it.opt("entity_id") == entityId }
            require(type != "progress" || remote != null && remote.isNull("deleted_at")) { "The synced XP balance is missing." }
            require(remote != null || type == "daily_plans" || type == "tasks" && entityId in missing)
            val derived = latest?.let { last -> (afterRows.map(NativeCompletionAdmissionEvidence::member) + afterCompletions.values.flatten()).single { it.opt("mutationId") == last.opt("mutationId") } }
            if (remote != null) {
                applyBusiness(NativeRemoteRecord(type, entityId, remote.getLong("version"), remote.getLong("server_version"), remote.getString("device_id"),
                    (derived?.getJSONObject("payload") ?: remote.getJSONObject("payload")).toString(), remote.getString("updated_at"), if (remote.isNull("deleted_at")) null else remote.getString("deleted_at")), if (derived != null) causal else null)
            } else when (type) {
                "tasks" -> database.taskDao().delete(entityId)
                "daily_plans" -> database.dailyPlanDao().delete(entityId)
            }
            for (successor in outbox.getAll().filter { it.dependsOnMutationId == member.getString("mutationId") }) {
                require(successor.attemptedAt == null)
                outbox.insert(successor.copy(baseServerVersion = remote?.getLong("server_version"), dependsOnMutationId = null))
            }
            val key = "$type:$entityId"; val meta = database.syncMetaDao().get(key)
            database.syncMetaDao().insert(SyncMetaEntity(key, meta?.cursor ?: 0, maxOf(meta?.localVersion ?: 0, version), remote?.getLong("server_version"), meta?.lastSuccessfulSync))
        }
        if (causal != null) {
            NativeCompletionAdmissionEvidence.validate(id, causal)
            check(database.causalAccountDao().update(causalEntity!!.copy(payload = causal.toString())) == 1)
        }
        val resolutions = planning.optJSONObject("resolutions") ?: JSONObject()
        resolutions.put(operationId, JSONObject().put("pending", JSONObject(pending.toString())).put("snapshot", snapshot).put("choice", if (useDraft) "draft" else "synced"))
        planning.put("resolutions", resolutions)
        val receipts = planning.optJSONObject("receipts") ?: JSONObject()
        receipts.put(operationId, pending.getJSONObject("response")); planning.put("receipts", receipts)
        planning.getJSONObject("pending").remove(operationId); planning.getJSONObject("days").put(day, snapshot.getJSONObject("policy"))
        if (useDraft) {
            val draft = JSONObject(command.toString()); draft.remove("operationId"); draft.remove("capturedAt")
            draft.put("baselineRevision", snapshot.getJSONObject("policy").get("revision")).put("maximumAcceptedXp", 0).put("updatedAt", command.getString("capturedAt"))
            planning.getJSONObject("drafts").put(day, draft)
        }
        save(id, state)
    }
    suspend fun validateSavedEdits(rows: List<SyncOutboxEntity>) {
        val id = account(); val saved = dao.get(id) ?: return
        val graph = JSONObject(saved.payload).getJSONObject("planning").optJSONObject("rebase") ?: return
        require(graph.opt("accountId") == id)
        NativePlanningCompletionRebase.validateEdits(graph, rows)
        database.causalAccountDao().get(id)?.let { entity ->
            val causal = JSONObject(entity.payload)
            for (field in listOf("planningResolutions", "planningEdits")) require(ActionJson.canonical(graph.opt(field)) == ActionJson.canonical(causal.opt(field)))
            val originals = graph.getJSONObject("completionAdmissions")
            for (action in originals.keys()) require(ActionJson.canonical(originals.get(action)) == ActionJson.canonical(causal.getJSONObject("completionAdmissions").get(action)))
        }
    }
    suspend fun retainReview(userId: String, command: JSONObject, input: JSONObject) = database.withTransaction {
        require(account() == userId)
        val snapshot = NativePlanningProtocol.review(userId, command, input)
        val state = state(userId)
        val pending = state.getJSONObject("planning").getJSONObject("pending").getJSONObject(command.getString("operationId"))
        require(pending.has("review") && pending.getString("request") == command.toString()
            && ActionJson.canonical(pending.getJSONObject("response")) == ActionJson.canonical(snapshot.getJSONObject("response")))
        val snapshots = pending.optJSONArray("reviewSnapshots") ?: JSONArray()
        if (objects(snapshots).none { ActionJson.canonical(it) == ActionJson.canonical(snapshot) }) snapshots.put(snapshot)
        pending.put("reviewSnapshots", snapshots); save(userId, state)
    }

    suspend fun prepare(userId: String): String? = database.withTransaction {
        require(account() == userId) { "Planning account changed." }
        if (dao.get(userId) == null) return@withTransaction null
        val state = state(userId); val planning = state.getJSONObject("planning")
        val pending = entries(planning.getJSONObject("pending")).minByOrNull { it.getLong("sequence") } ?: return@withTransaction null
        if (pending.has("review")) return@withTransaction null
        val dependencies = pending.getJSONArray("ordinaryDependencies")
        for (i in 0 until dependencies.length()) {
            require(planning.optJSONObject("ordinaryReceipts")?.optJSONObject(dependencies.getString(i))?.opt("accepted") == true) {
                "Earlier changes must synchronize before this order."
            }
        }
        val causal = database.causalAccountDao().get(userId)?.let { JSONObject(it.payload) }
        val causalDependencies = pending.getJSONArray("causalDependencies")
        for (i in 0 until causalDependencies.length()) require(causal?.optJSONObject("causalReceipts")?.has(causalDependencies.getString(i)) == true) {
            "Earlier focus actions must synchronize before this order."
        }
        val request = pending.getJSONObject("command").toString()
        require(!pending.has("request") || pending.getString("request") == request) { "Planning request bytes changed." }
        pending.put("request", request); save(userId, state); request
    }

    suspend fun commit(userId: String, command: JSONObject, input: JSONObject): Boolean = database.withTransaction {
        require(account() == userId)
        val response = NativePlanningProtocol.response(userId, command, input)
        val state = state(userId); val planning = state.getJSONObject("planning"); val id = command.getString("operationId")
        val receipts = planning.optJSONObject("receipts") ?: JSONObject()
        receipts.optJSONObject(id)?.let { require(ActionJson.canonical(it) == ActionJson.canonical(response)); return@withTransaction it.getJSONObject("receipt").opt("code") == "APPLIED" }
        val pending = planning.getJSONObject("pending").getJSONObject(id)
        require(pending.getString("request") == command.toString()) { "Planning response has no matching attempt." }
        pending.optJSONObject("response")?.let { require(ActionJson.canonical(it) == ActionJson.canonical(response)) }
        pending.put("response", response)
        fun review(reason: String): Boolean { pending.put("review", reason); return false }
        if (response.getJSONObject("receipt").getString("code") != "APPLIED") {
            review(response.getJSONObject("receipt").getString("code")); save(userId, state); return@withTransaction false
        }
        val records = objects(response.getJSONArray("records")); val members = objects(pending.getJSONArray("members"))
        val updates = mutableListOf<NativeRemoteRecord>()
        for (member in members) {
            val type = member.getString("entityType"); val entityId = member.getString("entityId")
            val remote = records.find { it.getString("entity_type") == type && it.getString("entity_id") == entityId }
            val current = readBusiness(type, entityId)
            if (remote == null || current == null) { review("A planned task changed elsewhere. Review both orders."); save(userId, state); return@withTransaction false }
            val base = NativePlanningProtocol.payload(type, member.getJSONObject("payload"))
            val authoritative = NativePlanningProtocol.payload(type, remote.getJSONObject("payload"))
            val later = outbox.getForEntity(type, entityId).any { it.version > member.getLong("version") }
                || (reservation(type, entityId)?.second?.getLong("version") ?: 0) > member.getLong("version")
                || database.causalAccountDao().get(userId)?.let { NativeCompletionAdmissionEvidence.reserved(JSONObject(it.payload), type, entityId)?.second?.getLong("version") ?: 0 }?.let { it > member.getLong("version") } == true
            if (later && ActionJson.canonical(base) != ActionJson.canonical(authoritative)) {
                review("The synced version differs from later saved changes. Review both versions."); save(userId, state); return@withTransaction false
            }
            val merged = JSONObject(current.toString())
            for (key in (base.keys().asSequence() + authoritative.keys().asSequence()).toSet()) {
                if (ActionJson.canonical(base.opt(key)) == ActionJson.canonical(authoritative.opt(key))) continue
                if (ActionJson.canonical(current.opt(key)) != ActionJson.canonical(base.opt(key)) && ActionJson.canonical(current.opt(key)) != ActionJson.canonical(authoritative.opt(key))) {
                    review("The same field changed on both devices. Review both versions."); save(userId, state); return@withTransaction false
                }
                if (authoritative.has(key)) merged.put(key, authoritative.get(key)) else merged.remove(key)
            }
            updates.add(NativeRemoteRecord(type, entityId, remote.getLong("version"), remote.getLong("server_version"), remote.getString("device_id"), merged.toString(), remote.getString("updated_at"), null))
        }
        for (record in updates) {
            applyBusiness(record, null)
            val member = members.single { it.getString("entityType") == record.entityType && it.getString("entityId") == record.entityId }
            for (successor in outbox.getAll().filter { it.dependsOnMutationId == member.getString("mutationId") }) {
                require(successor.attemptedAt == null) { "A successor was attempted before the order receipt." }
                outbox.insert(successor.copy(baseServerVersion = record.serverVersion, dependsOnMutationId = null))
            }
            val key = "${record.entityType}:${record.entityId}"; val meta = database.syncMetaDao().get(key)
            database.syncMetaDao().insert(SyncMetaEntity(key, meta?.cursor ?: 0, maxOf(meta?.localVersion ?: 0, member.getLong("version")),
                maxOf(meta?.serverVersion ?: 0, record.serverVersion), meta?.lastSuccessfulSync))
        }
        receipts.put(id, response); planning.put("receipts", receipts); planning.getJSONObject("pending").remove(id)
        if (entries(planning.getJSONObject("pending")).none { it.getJSONObject("command").opt("localDate") == command.opt("localDate") }) {
            planning.getJSONObject("days").put(command.getString("localDate"), response.getJSONObject("policy"))
        }
        database.causalAccountDao().get(userId)?.let { entity ->
            val causal = JSONObject(entity.payload); val replies = causal.optJSONObject("planningReceipts") ?: JSONObject()
            replies.put(id, response); causal.put("planningReceipts", replies)
            check(database.causalAccountDao().update(entity.copy(payload = causal.toString())) == 1)
        }
        save(userId, state); true
    }
}
