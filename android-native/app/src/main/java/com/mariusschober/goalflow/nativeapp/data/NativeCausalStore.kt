package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import com.mariusschober.goalflow.nativeapp.domain.TaskStatus
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

data class NativeFocusIntent(
    val actionId: String,
    val kind: String,
    val sessionId: String,
    val taskId: String,
    val expectedCurrentSessionId: String?,
    val durationSeconds: Long?,
    val capturedAt: String
) {
    fun json(accountId: String, actorId: String): JSONObject = JSONObject()
        .put("schemaVersion", 1).put("accountId", accountId).put("actorId", actorId)
        .put("actionId", actionId).put("kind", kind).put("sessionId", sessionId).put("taskId", taskId)
        .put("expectedCurrentSessionId", expectedCurrentSessionId ?: JSONObject.NULL)
        .put("durationSeconds", durationSeconds ?: JSONObject.NULL).put("capturedAt", capturedAt)
}

data class NativeCausalAdmission(val tracking: String, val outcome: String, val duplicate: Boolean, val generation: Long)

data class NativeCounterIntent(val actionId: String, val day: String, val timeZone: String,
    val counter: String, val capturedAt: String) {
    fun json(accountId: String, actorId: String): JSONObject = JSONObject()
        .put("schemaVersion", 1).put("accountId", accountId).put("actorId", actorId)
        .put("actionId", actionId).put("day", day).put("timeZone", timeZone)
        .put("counter", counter).put("delta", 1).put("capturedAt", capturedAt)
        .put("businessActionId", JSONObject.NULL).put("correctionOf", JSONObject.NULL)
}

data class NativeCounterDayIntent(val actionId: String, val kind: String, val day: String,
    val timeZone: String, val capturedAt: String) {
    fun json(accountId: String, actorId: String): JSONObject = JSONObject()
        .put("schemaVersion", 1).put("actionId", actionId).put("accountId", accountId)
        .put("actorId", actorId).put("kind", kind).put("day", day)
        .put("timeZone", timeZone).put("capturedAt", capturedAt)
}

data class NativeTaskCompletionIntent(
    val actionId: String, val taskId: String, val day: String, val timeZone: String,
    val actualDuration: Int?, val flowState: String?, val finalDescription: String?, val capturedAt: String
) {
    fun json(accountId: String, actorId: String): JSONObject = JSONObject()
        .put("schemaVersion", 1).put("accountId", accountId).put("actorId", actorId)
        .put("actionId", actionId).put("taskId", taskId).put("day", day).put("timeZone", timeZone)
        .put("actualDuration", actualDuration ?: JSONObject.NULL)
        .put("flowState", flowState ?: JSONObject.NULL)
        .put("finalDescription", finalDescription ?: JSONObject.NULL).put("capturedAt", capturedAt)
    fun validate() {
        require(ActionJson.identity(actionId) && taskId.isNotBlank() && taskId.length <= 240
            && ActionJson.day(day) && timeZone.matches(Regex("^[A-Za-z0-9_+./-]{1,128}$"))
            && (actualDuration == null || actualDuration >= 0)
            && (flowState == null || flowState in setOf("distracted", "good", "high", "flow"))
            && ActionJson.instant(capturedAt)
            && runCatching { java.time.ZoneId.of(timeZone) }.isSuccess) {
            "Invalid task completion intent. Nothing was completed." }
    }
}

data class NativeTaskCompletionAdmission(val actionId: String, val duplicate: Boolean, val generation: Long, val mutationIds: List<String>)

/** A replayable private journal. Unknown fields and original serialized legacy
 * payloads survive; wall-clock timestamps never choose the causal parent. */
object NativeCausalJournal {
    fun protectedTracking(value: JSONObject): JSONObject = JSONObject().apply {
        for (key in listOf("date", "planViewCount", "dailyPostponeCount", "focusSession")) {
            if (value.has(key)) put(key, value.get(key))
        }
    }

    fun validate(account: CausalAccountEntity): JSONObject {
        require(ActionJson.identity(account.accountId)) { "Invalid causal account identity." }
        val state = JSONObject(account.payload)
        val generation = ActionJson.integer(state.opt("generation"))
        require(ActionJson.integer(state.opt("schemaVersion")) == 1L && state.opt("accountId") == account.accountId
            && generation != null && generation >= 0) { "The native causal journal is damaged." }
        val replay = NativeCausalTimeline.replay(account.accountId, state)
        require(ActionJson.canonical(replay.focus) == ActionJson.canonical(state.getJSONObject("focus"))) {
            "The focus projection differs from its journal."
        }
        require(ActionJson.canonical(protectedTracking(replay.tracking)) == ActionJson.canonical(protectedTracking(state.getJSONObject("tracking")))) {
            "Tracking differs from its causal evidence."
        }
        require(ActionJson.canonical(replay.selection) == ActionJson.canonical(state.opt("counterDaySelection"))) {
            "The selected day differs from its original intent."
        }
        if (state.has("projectionAdmissions")) require(ActionJson.canonical(replay.reviews) == ActionJson.canonical(state.getJSONObject("causalProjectionReviews"))) {
            "The projection reviews differ from retained evidence."
        } else require(!state.has("causalProjectionReviews")) { "Projection reviews require a retained basis." }
        val admissions = state.getJSONObject("focusAdmissions")
        for ((admissionKey, pendingKey, commandKey) in listOf(
            Triple("counterAdmissions", "counterOutbox", "event"), Triple("counterDayAdmissions", "counterDayOutbox", "command"))) {
            if (!state.has(admissionKey) && !state.has(pendingKey)) continue
            val admitted = state.getJSONObject(admissionKey); val pendingCommands = state.getJSONObject(pendingKey)
            for (id in pendingCommands.keys()) require(admitted.has(id)) { "A pending action has no admission." }
            for (id in admitted.keys()) require(if (pendingCommands.has(id))
                ActionJson.canonical(admitted.getJSONObject(id).getJSONObject(commandKey)) == ActionJson.canonical(pendingCommands.getJSONObject(id))
                else NativeCausalRequestJournal.canRetire(account.accountId, state, id)) { "An admission is missing its exact pending command or applied receipt." }
        }
        val pending = state.getJSONObject("focusOutbox")
        for (id in admissions.keys()) {
            val accepted = admissions.getJSONObject(id).getJSONObject("outcome").getBoolean("accepted")
            require(if (accepted) pending.has(id) || NativeCausalRequestJournal.canRetire(account.accountId, state, id) else !pending.has(id)) {
                "A focus admission is missing its pending command."
            }
        }
        for (id in pending.keys()) {
            val admission = admissions.getJSONObject(id)
            require(admission.getJSONObject("outcome").getBoolean("accepted")
                && ActionJson.canonical(pending.getJSONObject(id)) == ActionJson.canonical(admission.getJSONObject("command"))) {
                "A pending focus command has no exact admission."
            }
        }
        if (state.has("causalHistory")) {
            val history = state.getJSONObject("causalHistory")
            NativeSavedCausalHistory.validate(account.accountId, history)
            if (history.getLong("downloadedRevision") >= 0) NativeCausalReplay.replay(account.accountId, history)
        }
        NativeCausalEnrollmentProtocol.validate(account.accountId, state)
        NativeCausalRequestJournal.validate(account.accountId, state)
        NativeCompletionApplicationEvidence.validate(state)
        NativeCompletionAdmissionEvidence.validate(account.accountId, state)
        NativeLegacyReceiptEvidence.validate(account.accountId, state)
        NativeTrackingPullEvidence.validate(account.accountId, state)
        return state
    }

    fun validateDay(command: JSONObject, accountId: String) {
        val actor = command.opt("actorId")
        val zone = command.opt("timeZone")
        require(ActionJson.integer(command.opt("schemaVersion")) == 1L
            && ActionJson.identity(command.opt("actionId")) && command.opt("accountId") == accountId
            && actor is String && actor.length in 1..240 && actor.isNotBlank()
            && command.opt("kind") in setOf("establish", "select") && ActionJson.day(command.opt("day"))
            && zone is String && Regex("^[A-Za-z0-9_+./-]{1,128}$").matches(zone)
            && ActionJson.instant(command.opt("capturedAt"))) { "Invalid counter day command." }
    }
}

/** Room owns baseline capture, actual-parent reads, projection and enqueue.
 * Enabling this journal is explicit until native transport is integrated. */
class NativeCausalStore(private val database: GoalflowDatabase, private val actorId: String) {
    private val accounts = database.causalAccountDao()

    private suspend fun bound(accountId: String) {
        require(ActionJson.identity(accountId) && database.localAccountDao().get()?.userId == accountId) {
            "The causal command does not belong to this database account."
        }
    }

    suspend fun enable(accountId: String, initialDay: String): CausalAccountEntity = database.withTransaction {
        bound(accountId)
        accounts.get(accountId)?.let { NativeCausalJournal.validate(it); return@withTransaction it }
        require(accounts.getAll().isEmpty()) { "A different causal account is retained." }
        val raw = database.rawCollectionDao().get("tracking")
        require(raw?.deletedAt == null) { "Deleted tracking requires explicit recovery." }
        if (raw == null) require(database.syncOutboxDao().getAll().none { it.entityType == "tracking" }
            && database.syncMetaDao().getAll().none { it.entityType == "tracking" || it.entityType == "tracking:singleton" }
            && database.syncConflictDao().getAll().none { it.entityType == "tracking" }) {
            "Missing tracking has historical evidence. Explicit recovery is required."
        }
        val tracking = raw?.let { JSONObject(it.payload) } ?: JSONObject().put("date", initialDay)
            .put("planViewCount", 0).put("dailyPostponeCount", 0).put("focusSession", JSONObject.NULL)
        val originalRaw = raw?.let { JSONObject().put("payload", it.payload).put("updatedAt", it.updatedAt)
            .put("deletedAt", it.deletedAt ?: JSONObject.NULL) }
        val meta = JSONArray(database.syncMetaDao().getAll().map { row -> JSONObject()
            .put("entityType", row.entityType).put("cursor", row.cursor).put("localVersion", row.localVersion)
            .put("serverVersion", row.serverVersion ?: JSONObject.NULL).put("lastSuccessfulSync", row.lastSuccessfulSync ?: JSONObject.NULL) })
        val legacy = JSONArray(database.syncOutboxDao().getAll().filter { it.entityType == "tracking" }.map { row -> JSONObject()
            .put("mutationId", row.mutationId).put("deviceId", row.deviceId).put("entityType", row.entityType).put("entityId", row.entityId)
            .put("baseServerVersion", row.baseServerVersion ?: JSONObject.NULL).put("version", row.version).put("payload", row.payload)
            .put("updatedAt", row.updatedAt).put("deletedAt", row.deletedAt ?: JSONObject.NULL)
            .put("dependsOnMutationId", row.dependsOnMutationId ?: JSONObject.NULL).put("resolvesConflictId", row.resolvesConflictId ?: JSONObject.NULL)
            .put("attemptedAt", row.attemptedAt ?: JSONObject.NULL) })
        val state = JSONObject().put("schemaVersion", 1).put("accountId", accountId).put("generation", 0)
            .put("cutover", JSONObject().put("tracking", originalRaw ?: JSONObject.NULL).put("syncMeta", meta).put("outbox", legacy))
            .put("tracking", tracking).put("focus", CausalFocus.initial(accountId,
                if (!tracking.has("focusSession") || tracking.isNull("focusSession")) null else tracking.getJSONObject("focusSession")))
            .put("focusAdmissions", JSONObject()).put("focusOutbox", JSONObject())
        if (raw == null) state.put("localInitialization", JSONObject(tracking.toString()))
        val entity = CausalAccountEntity(accountId, state.toString())
        NativeCausalJournal.validate(entity)
        accounts.insert(entity)
        if (raw == null) database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(),
            ActionJson.instantFormatter.format(Instant.now()), null))
        entity
    }

    suspend fun admitFocus(accountId: String, captured: NativeFocusIntent): NativeCausalAdmission =
        admitFocus(accountId, captured, null, null)

    internal suspend fun admitCompletion(accountId: String, captured: NativeFocusIntent, details: NativeCompletionDetails,
        effects: suspend (JSONObject, JSONObject) -> JSONObject): NativeCausalAdmission {
        require(captured.kind == "complete") { "Completion requires a completion intent." }
        return admitFocus(accountId, captured, details.json(), effects)
    }

    private suspend fun admitFocus(accountId: String, captured: NativeFocusIntent, details: JSONObject?,
        effects: (suspend (JSONObject, JSONObject) -> JSONObject)?): NativeCausalAdmission {
        val intent = captured.json(accountId, actorId)
        return database.withTransaction {
            bound(accountId)
            val entity = accounts.get(accountId) ?: error("Causal account preparation is required.")
            val state = NativeCausalJournal.validate(entity)
            val mirror = database.rawCollectionDao().get("tracking")
            require(mirror != null && mirror.deletedAt == null
                && ActionJson.canonical(JSONObject(mirror.payload)) == ActionJson.canonical(state.getJSONObject("tracking"))) {
                "Tracking changed outside its causal journal. Original evidence is retained."
            }
            val admissions = state.getJSONObject("focusAdmissions")
            require(state.optJSONObject("counterAdmissions")?.has(captured.actionId) != true) { "The action identity is already a counter event." }
            require(state.optJSONObject("counterDayAdmissions")?.has(captured.actionId) != true) { "The action identity is already a day command." }
            admissions.optJSONObject(captured.actionId)?.let { prior ->
                require(ActionJson.canonical(prior.getJSONObject("intent")) == ActionJson.canonical(intent)) { "The focus action identity has different intent." }
                require(ActionJson.canonical(state.optJSONObject("completionAdmissions")?.optJSONObject(captured.actionId)?.opt("details"))
                    == ActionJson.canonical(details)) { "The completion action identity has different final details." }
                return@withTransaction NativeCausalAdmission(state.getJSONObject("tracking").toString(), prior.getJSONObject("outcome").toString(), true, state.getLong("generation"))
            }
            require((captured.kind == "complete") == (details != null && effects != null)) { "Completion requires the atomic task-and-notes coordinator." }
            val task = database.taskDao().get(captured.taskId)
            require(task != null && task.deletedAt == null
                && (captured.kind !in setOf("start", "resume", "extendAndResume") || task.status == TaskStatus.OPEN.name)) {
                "The focus task is no longer eligible."
            }
            val focus = state.getJSONObject("focus")
            val sessions = focus.getJSONObject("sessions")
            val parent = if (captured.kind == "start") {
                if (focus.isNull("currentSessionId")) null else sessions.getJSONObject(focus.getString("currentSessionId"))
            } else sessions.optJSONObject(captured.sessionId)
            if (captured.kind == "start" && parent?.getJSONObject("projection")?.optString("phase") in setOf("active", "paused")) {
                val previousTask = database.taskDao().get(parent!!.getJSONObject("projection").getString("taskId"))
                require(previousTask?.status != TaskStatus.OPEN.name || previousTask?.deletedAt != null) { "Another focus session is already open." }
            }
            val command = JSONObject(intent.toString()).put("expectedRevision", parent?.opt("revision") ?: JSONObject.NULL)
                .put("epoch", if (captured.kind == "start") captured.actionId else parent?.opt("epoch") ?: captured.sessionId)
            val result = CausalFocus.apply(focus, command)
            if (details != null) {
                val capability = NativeCausalEnrollmentProtocol.capability(accountId, state.getJSONObject("causalCapability"))
                require(capability.getBoolean("enrolled")) { "Completion requires the established account epoch." }
                val completion = if (result.outcome.getBoolean("accepted")) requireNotNull(effects).invoke(state, command)
                    else JSONObject().put("members", JSONArray()).put("dependencies", JSONObject()).put("preimages", JSONObject())
                completion.put("details", details).put("epoch", capability.getString("epoch"))
                val entries = state.optJSONObject("completionAdmissions") ?: JSONObject()
                entries.put(captured.actionId, completion); state.put("completionAdmissions", entries)
            }
            val generation = state.getLong("generation") + 1
            require(generation <= ActionJson.MAX_SAFE_INTEGER) { "Local causal generation exhausted." }
            admissions.put(captured.actionId, JSONObject().put("intent", intent).put("command", command)
                .put("outcome", result.outcome).put("sequence", generation))
            state.put("focus", result.journal).put("generation", generation)
            val tracking = state.getJSONObject("tracking")
            if (result.outcome.getBoolean("accepted")) {
                tracking.put("focusSession", result.journal.getJSONObject("sessions").getJSONObject(captured.sessionId).getJSONObject("projection"))
                state.getJSONObject("focusOutbox").put(captured.actionId, command)
            }
            NativeCausalTimeline.materialize(accountId, state)
            val updated = CausalAccountEntity(accountId, state.toString())
            NativeCausalJournal.validate(updated)
            check(accounts.update(updated) == 1) { "The causal account disappeared." }
            database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), captured.capturedAt, null))
            NativeCausalAdmission(tracking.toString(), result.outcome.toString(), false, generation)
        }
    }

    suspend fun admitCounter(accountId: String, captured: NativeCounterIntent): NativeCausalAdmission {
        val event = captured.json(accountId, actorId)
        return database.withTransaction {
            bound(accountId)
            val entity = accounts.get(accountId) ?: error("Causal account preparation is required.")
            val state = NativeCausalJournal.validate(entity)
            val tracking = state.getJSONObject("tracking")
            val mirror = database.rawCollectionDao().get("tracking")
            require(mirror != null && mirror.deletedAt == null
                && ActionJson.canonical(JSONObject(mirror.payload)) == ActionJson.canonical(tracking)) {
                "Tracking changed outside its causal journal. Original evidence is retained."
            }
            require(!state.getJSONObject("focusAdmissions").has(captured.actionId)) { "The action identity is already a focus command." }
            require(state.optJSONObject("counterDayAdmissions")?.has(captured.actionId) != true) { "The action identity is already a day command." }
            val admissions = state.optJSONObject("counterAdmissions") ?: JSONObject().also { state.put("counterAdmissions", it) }
            val pending = state.optJSONObject("counterOutbox") ?: JSONObject().also { state.put("counterOutbox", it) }
            val basis = NativeCausalTimeline.replay(accountId, state)
            val outcome = JSONObject().put("accepted", true).put("baselinePending", !basis.baselines.has(captured.day))
            admissions.optJSONObject(captured.actionId)?.let { previous ->
                require(ActionJson.canonical(previous.getJSONObject("event")) == ActionJson.canonical(event)) {
                    "The counter action identity has different intent."
                }
                return@withTransaction NativeCausalAdmission(tracking.toString(), basis.admissionOutcomes.getJSONObject(captured.actionId).toString(), true, state.getLong("generation"))
            }
            val days = state.optJSONObject("counterDayAdmissions") ?: JSONObject()
            require(basis.baselines.has(captured.day) || days.keys().asSequence().any {
                days.getJSONObject(it).getJSONObject("command").getString("day") == captured.day
            }) { "This counter day requires a durable day admission before waiting for its baseline." }
            val generation = state.getLong("generation") + 1
            require(generation <= ActionJson.MAX_SAFE_INTEGER) { "Local causal generation exhausted." }
            admissions.put(captured.actionId, JSONObject().put("event", event).put("sequence", generation).put("outcome", outcome))
            pending.put(captured.actionId, event)
            state.put("generation", generation)
            NativeCausalTimeline.materialize(accountId, state)
            val updated = CausalAccountEntity(accountId, state.toString())
            NativeCausalJournal.validate(updated)
            check(accounts.update(updated) == 1) { "The causal account disappeared." }
            database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), captured.capturedAt, null))
            NativeCausalAdmission(tracking.toString(), outcome.toString(), false, generation)
        }
    }

    suspend fun admitCounterDay(accountId: String, captured: NativeCounterDayIntent): NativeCausalAdmission {
        val command = captured.json(accountId, actorId)
        NativeCausalJournal.validateDay(command, accountId)
        return database.withTransaction {
            bound(accountId)
            val entity = accounts.get(accountId) ?: error("Causal account preparation is required.")
            val state = NativeCausalJournal.validate(entity)
            val tracking = state.getJSONObject("tracking")
            val mirror = database.rawCollectionDao().get("tracking")
            require(mirror != null && mirror.deletedAt == null
                && ActionJson.canonical(JSONObject(mirror.payload)) == ActionJson.canonical(tracking)) {
                "Tracking changed outside its causal journal. Original evidence is retained."
            }
            require(!state.getJSONObject("focusAdmissions").has(captured.actionId)
                && state.optJSONObject("counterAdmissions")?.has(captured.actionId) != true) { "The action identity is already in use." }
            val admissions = state.optJSONObject("counterDayAdmissions") ?: JSONObject().also { state.put("counterDayAdmissions", it) }
            val pending = state.optJSONObject("counterDayOutbox") ?: JSONObject().also { state.put("counterDayOutbox", it) }
            val basis = NativeCausalTimeline.replay(accountId, state)
            val outcome = JSONObject().put("accepted", true).put("baselinePending", !basis.baselines.has(captured.day))
            admissions.optJSONObject(captured.actionId)?.let { prior ->
                require(ActionJson.canonical(prior.getJSONObject("command")) == ActionJson.canonical(command)) { "The day action identity has different intent." }
                return@withTransaction NativeCausalAdmission(tracking.toString(), basis.admissionOutcomes.getJSONObject(captured.actionId).toString(), true, state.getLong("generation"))
            }
            val generation = state.getLong("generation") + 1
            require(generation <= ActionJson.MAX_SAFE_INTEGER) { "Local causal generation exhausted." }
            admissions.put(captured.actionId, JSONObject().put("command", command).put("sequence", generation).put("outcome", outcome))
            pending.put(captured.actionId, command)
            state.put("generation", generation)
            NativeCausalTimeline.materialize(accountId, state)
            val updated = CausalAccountEntity(accountId, state.toString())
            NativeCausalJournal.validate(updated)
            check(accounts.update(updated) == 1) { "The causal account disappeared." }
            if (ActionJson.canonical(JSONObject(mirror.payload)) != ActionJson.canonical(tracking)) {
                database.rawCollectionDao().insert(RawCollectionEntity("tracking", tracking.toString(), captured.capturedAt, null))
            }
            NativeCausalAdmission(tracking.toString(), outcome.toString(), false, generation)
        }
    }

    /** Task-only completion for prepared accounts. Business effects derive
     * inside this same Room transaction through [effects], which must apply
     * the task/statistics/goal/habit/event transition and enqueue ordinary
     * outbox rows, returning false when the task is already completed.
     * Members keep the exact ordinary receipt contract with their dependency
     * chain; the journal only records the immutable admission for
     * idempotent retries. */
    suspend fun admitTaskCompletion(
        accountId: String, captured: NativeTaskCompletionIntent, effects: suspend () -> Boolean
    ): NativeTaskCompletionAdmission {
        captured.validate()
        val intent = captured.json(accountId, actorId)
        return database.withTransaction {
            bound(accountId)
            val entity = accounts.get(accountId) ?: error("Causal account preparation is required.")
            val state = NativeCausalJournal.validate(entity)
            val admissions = state.optJSONObject("taskCompletionAdmissions") ?: JSONObject().also { state.put("taskCompletionAdmissions", it) }
            admissions.optJSONObject(captured.actionId)?.let { prior ->
                require(ActionJson.canonical(prior.getJSONObject("intent")) == ActionJson.canonical(intent)) {
                    "The task completion action identity has different intent." }
                val mutationIds = prior.getJSONArray("mutationIds").let { array -> (0 until array.length()).map { array.getString(it) } }
                return@withTransaction NativeTaskCompletionAdmission(captured.actionId, true, state.getLong("generation"), mutationIds)
            }
            for (key in listOf("focusAdmissions", "counterAdmissions", "counterDayAdmissions", "completionAdmissions")) {
                require(state.optJSONObject(key)?.has(captured.actionId) != true) { "The task completion action identity is already in use." }
            }
            val before = database.syncOutboxDao().getAll().associateBy { it.mutationId }
            require(effects()) { "The completion task is no longer open. Nothing was completed." }
            val generated = database.syncOutboxDao().getAll().filter { it.mutationId !in before }
            require(generated.isNotEmpty() && generated.all { it.attemptedAt == null }) {
                "The task completion produced no transportable change. Nothing was completed." }
            require(before.all { (id, original) -> database.syncOutboxDao().get(id) == original }) {
                "Completion changed an existing queued request." }
            val generation = state.getLong("generation")
            admissions.put(captured.actionId, JSONObject().put("intent", intent)
                .put("mutationIds", org.json.JSONArray(generated.map { it.mutationId })))
            // The local generation sequence stays with timeline admissions
            // (focus/counter/day/projection): task-only members order through
            // the ordinary outbox version chain instead.
            NativeCausalTimeline.materialize(accountId, state)
            val updated = CausalAccountEntity(accountId, state.toString())
            NativeCausalJournal.validate(updated)
            check(accounts.update(updated) == 1) { "The causal account disappeared." }
            NativeTaskCompletionAdmission(captured.actionId, false, generation, generated.map { it.mutationId })
        }
    }
}
