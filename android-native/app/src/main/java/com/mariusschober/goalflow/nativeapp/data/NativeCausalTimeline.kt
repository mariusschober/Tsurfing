package com.mariusschober.goalflow.nativeapp.data

import com.mariusschober.goalflow.nativeapp.domain.TaskStatus
import org.json.JSONArray
import org.json.JSONObject

data class NativeCausalTimelineResult(
    val tracking: JSONObject, val focus: JSONObject, val baselines: JSONObject,
    val events: JSONObject, val selection: JSONObject?, val reviews: JSONObject,
    val admissionOutcomes: JSONObject
)

/** Replay local admissions around the server revisions actually applied between
 * them. A later projection must never rewrite a captured parent or outcome.
 * Pending overlays are derived views; they are not new admissions or receipts. */
object NativeCausalTimeline {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    private fun copy(value: JSONObject) = JSONObject(value.toString())
    private fun values(value: JSONObject) = JSONArray(value.keys().asSequence().map { value.getJSONObject(it) }.toList())
    private data class Step(val sequence: Long, val type: String, val id: String, val value: JSONObject)

    fun original(state: JSONObject): JSONObject {
        val cutover = state.getJSONObject("cutover")
        return if (cutover.isNull("tracking")) {
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
    }

    fun replay(accountId: String, state: JSONObject): NativeCausalTimelineResult {
        val generation = ActionJson.integer(state.opt("generation"))
        require(ActionJson.identity(accountId) && state.opt("accountId") == accountId
            && ActionJson.integer(state.opt("schemaVersion")) == 1L && generation != null && generation >= 0) {
            "The native causal journal is damaged."
        }
        val original = original(state)
        var tracking = copy(original)
        var focus = CausalFocus.initial(accountId,
            if (!original.has("focusSession") || original.isNull("focusSession")) null else original.getJSONObject("focusSession"))
        val baseline = JSONObject().put("schemaVersion", 1).put("baselineId", accountId).put("accountId", accountId)
            .put("day", original.get("date")).put("evidenceIds", JSONArray())
            .put("counts", JSONObject().put("planViewCount", original.get("planViewCount"))
                .put("dailyPostponeCount", original.get("dailyPostponeCount")))
        CounterLedger.project(baseline, JSONArray())
        var baselines = JSONObject().put(baseline.getString("day"), baseline)
        var events = JSONObject()
        var selection: JSONObject? = null
        var reviews = JSONObject()
        val outcomes = JSONObject()
        val admittedFocus = JSONObject(); val admittedCounters = JSONObject(); val admittedDays = JSONObject()
        val sequences = mutableSetOf<Long>(); val identities = mutableSetOf<String>(); val steps = mutableListOf<Step>()
        for ((key, type) in listOf("focusAdmissions" to "focus", "counterAdmissions" to "counter",
            "counterDayAdmissions" to "counterDay", "projectionAdmissions" to "projection")) {
            val entries = if (state.has(key)) state.getJSONObject(key) else JSONObject()
            for (id in entries.keys()) {
                val entry = entries.getJSONObject(id); val sequence = ActionJson.integer(entry.opt("sequence"))
                require(sequence != null && sequence in 1..generation && sequences.add(sequence)
                    && (if (type == "projection") id == sequence.toString() else ActionJson.identity(id) && identities.add(id))) {
                    "The causal admission identity or sequence is damaged."
                }
                steps.add(Step(sequence, type, id, entry))
            }
        }
        require(sequences.size.toLong() == generation) { "The causal admission sequence is incomplete." }
        var appliedRevision = -1L
        var reserved = emptySet<String>()
        val canonicalCache = mutableMapOf<Long, NativeCausalReplayResult>()
        fun projectCounts() {
            val established = baselines.getJSONObject(tracking.getString("date"))
            val counts = CounterLedger.project(established, values(events))
            tracking.put("planViewCount", counts.get("planViewCount")).put("dailyPostponeCount", counts.get("dailyPostponeCount"))
        }
        fun projectFocus() {
            if (!focus.isNull("currentSessionId")) tracking.put("focusSession",
                focus.getJSONObject("sessions").getJSONObject(focus.getString("currentSessionId")).getJSONObject("projection"))
        }
        for (step in steps.sortedBy { it.sequence }) {
            val (sequence, type, id, entry) = step
            if (type != "projection") require(id !in reserved) { "A new admission reuses an already represented server identity." }
            when (type) {
                "focus" -> {
                    val command = entry.getJSONObject("command")
                    require(command.opt("actionId") == id && command.opt("accountId") == accountId) { "The focus admission identity is damaged." }
                    val intent = copy(command).apply { remove("expectedRevision"); remove("epoch") }
                    require(same(intent, entry.getJSONObject("intent"))) { "The original focus intent differs." }
                    val result = CausalFocus.apply(focus, command)
                    require(same(result.outcome, entry.getJSONObject("outcome"))) { "The focus admission outcome differs." }
                    focus = result.journal; admittedFocus.put(id, entry); outcomes.put(id, result.outcome)
                    projectFocus()
                }
                "counter" -> {
                    val event = entry.getJSONObject("event")
                    require(event.opt("actionId") == id && event.opt("accountId") == accountId
                        && (baselines.has(event.getString("day")) || admittedDays.keys().asSequence().any {
                            admittedDays.getJSONObject(it).getJSONObject("command").opt("day") == event.opt("day") })
                        && event.has("correctionOf") && event.isNull("correctionOf")
                        && event.has("businessActionId") && event.isNull("businessActionId")) {
                        "The counter admission identity or scope is damaged."
                    }
                    events.put(id, event); admittedCounters.put(id, entry)
                    val outcome = JSONObject().put("accepted", true).put("baselinePending", !baselines.has(event.getString("day")))
                    if (entry.has("outcome")) require(same(outcome, entry.getJSONObject("outcome"))) { "The counter admission outcome differs." }
                    outcomes.put(id, outcome)
                    baselines.optJSONObject(event.getString("day"))?.let { CounterLedger.project(it, values(events)) }
                    projectCounts()
                }
                "counterDay" -> {
                    val command = entry.getJSONObject("command"); NativeCausalJournal.validateDay(command, accountId)
                    require(command.opt("actionId") == id) { "The day admission identity is damaged." }
                    admittedDays.put(id, entry)
                    val known = baselines.has(command.getString("day"))
                    val outcome = JSONObject().put("accepted", true).put("baselinePending", !known)
                    if (entry.has("outcome")) require(same(outcome, entry.getJSONObject("outcome"))) { "The day admission outcome differs." }
                    outcomes.put(id, outcome)
                    if (command.getString("kind") == "select") {
                        selection = JSONObject().put("actionId", id).put("requestedDay", command.getString("day"))
                            .put("status", if (known) "PROJECTED" else "WAITING_BASELINE")
                        if (known) tracking.put("date", command.getString("day"))
                        projectCounts()
                    }
                }
                "projection" -> {
                    val revision = ActionJson.integer(entry.opt("revision"))
                    val history = state.getJSONObject("causalHistory")
                    val capability = NativeCausalEnrollmentProtocol.capability(accountId, state.getJSONObject("causalCapability"))
                    require(entry.keys().asSequence().toSet() == setOf("sequence", "epoch", "revision", "taskEvidence")
                        && revision != null && revision >= 0 && revision >= appliedRevision
                        && entry.opt("epoch") == history.opt("epoch") && capability.getBoolean("enrolled")
                        && entry.opt("epoch") == capability.opt("epoch") && revision <= capability.getLong("projectionRevision")) {
                        "The applied causal basis cannot change epoch or rewind."
                    }
                    val canonical = canonicalCache.getOrPut(revision) { NativeCausalReplay.replayAt(accountId, history, revision) }
                    val cutover = canonicalCache.getOrPut(0) { NativeCausalReplay.replayAt(accountId, history, 0) }
                    val proof = JSONObject(history.getJSONObject("entries").getJSONObject("0").getString("body")).getJSONObject("receipt")
                    if (state.has("cutoverReceipt")) require(same(proof, state.getJSONObject("cutoverReceipt"))) { "History differs from the retained cutover receipt." }
                    if (state.has("initializationReceipt")) require(same(proof, state.getJSONObject("initializationReceipt").getJSONObject("cutoverReceipt"))) {
                        "History differs from the retained initialization receipt."
                    }
                    if (!state.getJSONObject("cutover").isNull("tracking")) require(same(
                        NativeCausalJournal.protectedTracking(original), NativeCausalJournal.protectedTracking(cutover.tracking))) {
                        "The local cutover differs from server evidence. Explicit legacy recovery is required."
                    }
                    // Applying terminal focus before its task/notes/effects would
                    // expose partial completion. Keep downloaded evidence until
                    // the native business-member transaction is available.
                    require(canonical.receipts.keys().asSequence().none {
                        val receipt = canonical.receipts.getJSONObject(it)
                        receipt.getJSONObject("operation").getString("type") == "completion" && receipt.getBoolean("accepted")
                    }) { "Atomic completion member application is required before this history can be applied." }
                    val reservedIds = mutableSetOf(history.getString("epoch"))
                    for (day in canonical.baselines.keys()) reservedIds.add(canonical.baselines.getJSONObject(day).getString("baselineId"))
                    for (action in canonical.receipts.keys()) {
                        val receipt = canonical.receipts.getJSONObject(action); val operation = receipt.getJSONObject("operation")
                        reservedIds.add(action)
                        if (operation.getString("type") == "completion" && receipt.getBoolean("accepted")) {
                            val changes = operation.getJSONArray("changes")
                            for (index in 0 until changes.length()) reservedIds.add(changes.getJSONObject(index).getString("mutationId"))
                        }
                    }
                    for ((localType, local) in listOf("focus" to admittedFocus, "counter" to admittedCounters, "counterDay" to admittedDays)) {
                        for (action in local.keys()) if (action in reservedIds) {
                            val operation = canonical.receipts.optJSONObject(action)?.getJSONObject("operation")
                            val command = local.getJSONObject(action).getJSONObject(if (localType == "counter") "event" else "command")
                            require(operation != null && operation.opt("type") == localType && same(operation.opt("command"), command)) {
                                "A server identity differs from the original local admission."
                            }
                        }
                    }
                    reserved = reservedIds
                    baselines = copy(canonical.baselines); events = copy(canonical.events)
                    for (action in admittedCounters.keys()) {
                        val event = admittedCounters.getJSONObject(action).getJSONObject("event")
                        require(!events.has(action) || same(events.getJSONObject(action), event)) { "A counter identity differs from server evidence." }
                        events.put(action, event)
                    }
                    tracking = copy(canonical.tracking); focus = copy(canonical.focus); reviews = JSONObject(); selection = null
                    for (action in admittedCounters.keys()) {
                        val event = admittedCounters.getJSONObject(action).getJSONObject("event")
                        if (!baselines.has(event.getString("day"))) reviews.put(action, JSONObject().put("code", "BASELINE_REQUIRED"))
                    }
                    for (action in canonical.receipts.keys()) {
                        val receipt = canonical.receipts.getJSONObject(action)
                        if (!receipt.getBoolean("accepted")) reviews.put(action, JSONObject().put("code", receipt.getJSONObject("outcome").getString("code")))
                    }
                    val selections = admittedDays.keys().asSequence().map { admittedDays.getJSONObject(it) }
                        .filter { it.getJSONObject("command").getString("kind") == "select" }.sortedBy { it.getLong("sequence") }.toList()
                    val through = selections.filter { canonical.receipts.has(it.getJSONObject("command").getString("actionId")) }
                        .maxOfOrNull { it.getLong("sequence") } ?: 0L
                    for (admission in selections) if (admission.getLong("sequence") > through) {
                        val command = admission.getJSONObject("command"); val day = command.getString("day")
                        val known = baselines.has(day)
                        if (known) tracking.put("date", day)
                        selection = JSONObject().put("actionId", command.getString("actionId")).put("requestedDay", day)
                            .put("status", if (known) "PROJECTED" else "WAITING_BASELINE")
                    }
                    val pending = admittedFocus.keys().asSequence().filter {
                        admittedFocus.getJSONObject(it).getJSONObject("outcome").getBoolean("accepted") && !canonical.receipts.has(it)
                    }.map { admittedFocus.getJSONObject(it) }.sortedBy { it.getLong("sequence") }.toList()
                    val taskEvidence = entry.getJSONObject("taskEvidence")
                    require(taskEvidence.keys().asSequence().toSet() == pending.map { it.getJSONObject("command").getString("taskId") }.toSet()) {
                        "The pending focus task evidence is incomplete."
                    }
                    for (admission in pending) {
                        val command = admission.getJSONObject("command"); val action = command.getString("actionId")
                        val taskId = command.getString("taskId")
                        val task = if (taskEvidence.isNull(taskId)) null else taskEvidence.getJSONObject(taskId)
                        if (task != null) require(task.keys().asSequence().toSet() == setOf("status", "deletedAt")
                            && task.opt("status") in TaskStatus.entries.map { it.name }
                            && task.has("deletedAt") && (task.isNull("deletedAt") || ActionJson.integer(task.opt("deletedAt")) != null)) {
                            "The pending task evidence is invalid."
                        }
                        if (task == null || !task.isNull("deletedAt") || (command.getString("kind") in setOf("start", "resume", "extendAndResume")
                                && task.getString("status") != TaskStatus.OPEN.name)) {
                            reviews.put(action, JSONObject().put("code", "TASK_REVIEW_REQUIRED")); continue
                        }
                        val result = CausalFocus.apply(focus, command); focus = result.journal
                        if (!result.outcome.getBoolean("accepted")) reviews.put(action, JSONObject().put("code", result.outcome.getString("code")))
                    }
                    for (day in baselines.keys()) CounterLedger.project(baselines.getJSONObject(day), values(events))
                    projectCounts(); projectFocus(); appliedRevision = revision
                }
            }
        }
        return NativeCausalTimelineResult(tracking, focus, baselines, events, selection, reviews, outcomes)
    }

    /** Preserve ordinary unknown tracking fields while changing only the
     * protected projection derived from durable evidence. */
    fun materialize(accountId: String, state: JSONObject): NativeCausalTimelineResult {
        val result = replay(accountId, state); val tracking = state.getJSONObject("tracking")
        for (key in listOf("date", "planViewCount", "dailyPostponeCount", "focusSession")) {
            if (result.tracking.has(key)) tracking.put(key, result.tracking.get(key)) else tracking.remove(key)
        }
        state.put("focus", result.focus)
        if (result.selection != null) state.put("counterDaySelection", result.selection) else state.remove("counterDaySelection")
        if (state.has("projectionAdmissions")) state.put("causalProjectionReviews", result.reviews)
        return result
    }
}
