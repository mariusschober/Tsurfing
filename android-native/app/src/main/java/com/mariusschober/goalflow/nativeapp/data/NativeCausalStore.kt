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
        val cutover = state.getJSONObject("cutover")
        val original = if (cutover.isNull("tracking")) {
            state.getJSONObject("localInitialization").also {
                require(ActionJson.integer(it.opt("planViewCount")) == 0L
                    && ActionJson.integer(it.opt("dailyPostponeCount")) == 0L
                    && (!it.has("focusSession") || it.isNull("focusSession"))) { "Local defaults are not a legacy baseline." }
            }
        } else {
            val raw = cutover.getJSONObject("tracking")
            require(raw.isNull("deletedAt")) { "Deleted tracking requires recovery." }
            JSONObject(raw.getString("payload"))
        }
        val counts = JSONObject().put("planViewCount", original.get("planViewCount"))
            .put("dailyPostponeCount", original.get("dailyPostponeCount"))
        val baseline = JSONObject().put("schemaVersion", 1).put("baselineId", account.accountId)
            .put("accountId", account.accountId).put("day", original.get("date"))
            .put("counts", counts).put("evidenceIds", JSONArray())
        CounterLedger.project(baseline, JSONArray())
        val baselineFocus = if (!original.has("focusSession") || original.isNull("focusSession")) null
            else original.getJSONObject("focusSession")
        var focus = CausalFocus.initial(account.accountId, baselineFocus)
        val admissions = state.getJSONObject("focusAdmissions")
        val sequences = mutableSetOf<Long>()
        for (id in admissions.keys().asSequence().toList().sortedBy { admissions.getJSONObject(it).getLong("sequence") }) {
            val admission = admissions.getJSONObject(id)
            val command = admission.getJSONObject("command")
            val sequence = ActionJson.integer(admission.opt("sequence"))
            require(sequence != null && sequence > 0 && sequence <= generation && sequences.add(sequence)
                && command.opt("actionId") == id && command.opt("accountId") == account.accountId) { "The focus admission identity is damaged." }
            val intent = JSONObject(command.toString()).apply { remove("expectedRevision"); remove("epoch") }
            require(ActionJson.canonical(intent) == ActionJson.canonical(admission.getJSONObject("intent"))) { "The original focus intent differs." }
            val result = CausalFocus.apply(focus, command)
            require(ActionJson.canonical(result.outcome) == ActionJson.canonical(admission.getJSONObject("outcome"))) { "The focus admission outcome differs." }
            focus = result.journal
        }
        require(ActionJson.canonical(focus) == ActionJson.canonical(state.getJSONObject("focus"))) { "The focus projection differs from its journal." }
        val expectedTracking = JSONObject(original.toString())
        val days = state.optJSONObject("counterDayAdmissions") ?: JSONObject()
        if (state.has("counterDayAdmissions") || state.has("counterDayOutbox")) {
            val pendingDays = state.getJSONObject("counterDayOutbox")
            state.getJSONObject("counterDayAdmissions")
            var latestSelection: JSONObject? = null
            for (id in days.keys().asSequence().toList().sortedBy { days.getJSONObject(it).getLong("sequence") }) {
                val admission = days.getJSONObject(id)
                val command = admission.getJSONObject("command")
                val sequence = ActionJson.integer(admission.opt("sequence"))
                validateDay(command, account.accountId)
                require(sequence != null && sequence > 0 && sequence <= generation && sequences.add(sequence)
                    && command.opt("actionId") == id && !admissions.has(id)
                    && ActionJson.canonical(command) == ActionJson.canonical(pendingDays.getJSONObject(id))) {
                    "The day admission has no exact pending command or sequence."
                }
                if (command.getString("kind") == "select") latestSelection = JSONObject()
                    .put("actionId", id).put("requestedDay", command.getString("day"))
                    .put("status", if (command.getString("day") == original.getString("date")) "PROJECTED" else "WAITING_BASELINE")
            }
            require(days.length() == pendingDays.length()
                && ActionJson.canonical(latestSelection) == ActionJson.canonical(state.opt("counterDaySelection"))) {
                "The selected day differs from its original intent."
            }
        } else require(!state.has("counterDaySelection")) { "The selected day has no admission." }
        if (state.has("counterAdmissions") || state.has("counterOutbox")) {
            val counterAdmissions = state.getJSONObject("counterAdmissions")
            val counterOutbox = state.getJSONObject("counterOutbox")
            val events = JSONArray()
            for (id in counterAdmissions.keys()) {
                val admission = counterAdmissions.getJSONObject(id)
                val event = admission.getJSONObject("event")
                val sequence = ActionJson.integer(admission.opt("sequence"))
                require(sequence != null && sequence > 0 && sequence <= generation && sequences.add(sequence)
                    && event.opt("actionId") == id && !admissions.has(id) && !days.has(id)
                    && (event.opt("day") == baseline.getString("day") || days.keys().asSequence().any {
                        days.getJSONObject(it).getLong("sequence") < sequence
                            && days.getJSONObject(it).getJSONObject("command").opt("day") == event.opt("day") })
                    && event.isNull("correctionOf") && event.isNull("businessActionId")) {
                    "The counter admission identity or scope is damaged."
                }
                require(ActionJson.canonical(event) == ActionJson.canonical(counterOutbox.getJSONObject(id))) {
                    "A counter admission is missing its exact pending event."
                }
                events.put(event)
            }
            require(counterOutbox.length() == counterAdmissions.length()) { "A pending counter event has no admission." }
            val projected = CounterLedger.project(baseline, events)
            expectedTracking.put("planViewCount", projected.get("planViewCount"))
                .put("dailyPostponeCount", projected.get("dailyPostponeCount"))
        }
        require(sequences.size.toLong() == generation) { "The causal admission sequence is incomplete." }
        if (!focus.isNull("currentSessionId")) expectedTracking.put("focusSession",
            focus.getJSONObject("sessions").getJSONObject(focus.getString("currentSessionId")).getJSONObject("projection"))
        require(ActionJson.canonical(protectedTracking(expectedTracking)) == ActionJson.canonical(protectedTracking(state.getJSONObject("tracking")))) {
            "Tracking differs from its causal evidence."
        }
        val pending = state.getJSONObject("focusOutbox")
        for (id in admissions.keys()) {
            require(admissions.getJSONObject(id).getJSONObject("outcome").getBoolean("accepted") == pending.has(id)) {
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

    suspend fun admitFocus(accountId: String, captured: NativeFocusIntent): NativeCausalAdmission {
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
                return@withTransaction NativeCausalAdmission(state.getJSONObject("tracking").toString(), prior.getJSONObject("outcome").toString(), true, state.getLong("generation"))
            }
            require(captured.kind != "complete") { "Completion requires the atomic task-and-notes coordinator." }
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
            val outcome = JSONObject().put("accepted", true).put("baselinePending", captured.day != tracking.getString("date"))
            admissions.optJSONObject(captured.actionId)?.let { previous ->
                require(ActionJson.canonical(previous.getJSONObject("event")) == ActionJson.canonical(event)) {
                    "The counter action identity has different intent."
                }
                return@withTransaction NativeCausalAdmission(tracking.toString(), outcome.toString(), true, state.getLong("generation"))
            }
            val days = state.optJSONObject("counterDayAdmissions") ?: JSONObject()
            require(captured.day == tracking.getString("date") || days.keys().asSequence().any {
                days.getJSONObject(it).getJSONObject("command").getString("day") == captured.day
            }) { "This counter day requires a durable day admission before waiting for its baseline." }
            val baseline = JSONObject().put("schemaVersion", 1).put("baselineId", accountId)
                .put("accountId", accountId).put("day", tracking.getString("date")).put("evidenceIds", JSONArray())
                .put("counts", JSONObject().put("planViewCount", tracking.get("planViewCount"))
                    .put("dailyPostponeCount", tracking.get("dailyPostponeCount")))
            val projection = CounterLedger.project(baseline, JSONArray().put(event))
            val generation = state.getLong("generation") + 1
            require(generation <= ActionJson.MAX_SAFE_INTEGER) { "Local causal generation exhausted." }
            admissions.put(captured.actionId, JSONObject().put("event", event).put("sequence", generation))
            pending.put(captured.actionId, event)
            state.put("generation", generation)
            tracking.put("planViewCount", projection.get("planViewCount"))
                .put("dailyPostponeCount", projection.get("dailyPostponeCount"))
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
            val outcome = JSONObject().put("accepted", true).put("baselinePending", captured.day != tracking.getString("date"))
            admissions.optJSONObject(captured.actionId)?.let { prior ->
                require(ActionJson.canonical(prior.getJSONObject("command")) == ActionJson.canonical(command)) { "The day action identity has different intent." }
                return@withTransaction NativeCausalAdmission(tracking.toString(), outcome.toString(), true, state.getLong("generation"))
            }
            val generation = state.getLong("generation") + 1
            require(generation <= ActionJson.MAX_SAFE_INTEGER) { "Local causal generation exhausted." }
            admissions.put(captured.actionId, JSONObject().put("command", command).put("sequence", generation))
            pending.put(captured.actionId, command)
            state.put("generation", generation)
            if (captured.kind == "select") state.put("counterDaySelection", JSONObject().put("actionId", captured.actionId)
                .put("requestedDay", captured.day).put("status", if (outcome.getBoolean("baselinePending")) "WAITING_BASELINE" else "PROJECTED"))
            val updated = CausalAccountEntity(accountId, state.toString())
            NativeCausalJournal.validate(updated)
            check(accounts.update(updated) == 1) { "The causal account disappeared." }
            NativeCausalAdmission(tracking.toString(), outcome.toString(), false, generation)
        }
    }
}
