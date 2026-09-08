package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import org.json.JSONObject
import java.time.Instant

data class NativeCausalProjectionResult(val epoch: String, val revision: Long, val generation: Long,
    val duplicate: Boolean, val reviews: String)

/** The protected mirror and the admission basis commit together. Downloaded
 * evidence and ordinary sync cursors remain distinct. Pending commands retire
 * only against exact saved request/receipt evidence in this applied history. */
class NativeCausalProjectionStore(private val database: GoalflowDatabase) {
    suspend fun apply(accountId: String): NativeCausalProjectionResult = database.withTransaction {
        require(database.localAccountDao().get()?.userId == accountId) { "Projection account differs from this database." }
        val entity = database.causalAccountDao().get(accountId) ?: error("Causal account preparation is required.")
        val state = NativeCausalJournal.validate(entity)
        val history = state.getJSONObject("causalHistory")
        require(!history.has("partial") && history.getLong("downloadedRevision") == history.getLong("throughRevision")) {
            "Complete the retained history horizon before applying it."
        }
        val mirror = database.rawCollectionDao().get("tracking")
        require(mirror != null && mirror.deletedAt == null
            && ActionJson.canonical(JSONObject(mirror.payload)) == ActionJson.canonical(state.getJSONObject("tracking"))) {
            "Tracking changed outside its causal journal. Original evidence is retained."
        }
        val canonical = NativeCausalReplay.replay(accountId, history)
        val evidence = JSONObject(); val admissions = state.getJSONObject("focusAdmissions")
        for (id in admissions.keys()) {
            val admission = admissions.getJSONObject(id)
            if (!admission.getJSONObject("outcome").getBoolean("accepted") || canonical.receipts.has(id)) continue
            val taskId = admission.getJSONObject("command").getString("taskId")
            if (evidence.has(taskId)) continue
            val task = database.taskDao().get(taskId)
            evidence.put(taskId, task?.let { JSONObject().put("status", it.status).put("deletedAt", it.deletedAt ?: JSONObject.NULL) } ?: JSONObject.NULL)
        }
        val projectionAdmissions = state.optJSONObject("projectionAdmissions") ?: JSONObject()
        val latestRevision = projectionAdmissions.keys().asSequence().map { projectionAdmissions.getJSONObject(it) }
            .maxByOrNull { it.getLong("sequence") }?.getLong("revision") ?: -1L
        val revision = history.getLong("downloadedRevision"); val epoch = history.getString("epoch")
        val generation = state.getLong("generation") + 1
        require(generation <= ActionJson.MAX_SAFE_INTEGER) { "Local causal generation exhausted." }
        projectionAdmissions.put(generation.toString(), JSONObject().put("sequence", generation).put("epoch", epoch)
            .put("revision", revision).put("taskEvidence", evidence))
        val previousTracking = ActionJson.canonical(state.getJSONObject("tracking"))
        val previousFocus = ActionJson.canonical(state.getJSONObject("focus"))
        val previousSelection = ActionJson.canonical(state.opt("counterDaySelection"))
        val previousReviews = ActionJson.canonical(state.opt("causalProjectionReviews") ?: JSONObject())
        state.put("projectionAdmissions", projectionAdmissions).put("generation", generation)
        val result = NativeCausalTimeline.materialize(accountId, state)
        NativeCausalRequestJournal.reconcile(accountId, state, canonical)
        if (latestRevision == revision && previousTracking == ActionJson.canonical(state.getJSONObject("tracking"))
            && previousFocus == ActionJson.canonical(result.focus) && previousSelection == ActionJson.canonical(result.selection)
            && previousReviews == ActionJson.canonical(result.reviews)) {
            projectionAdmissions.remove(generation.toString()); state.put("generation", generation - 1)
            val duplicate = ActionJson.canonical(JSONObject(entity.payload)) == ActionJson.canonical(state)
            if (!duplicate) {
                val updated = entity.copy(payload = state.toString()); NativeCausalJournal.validate(updated)
                check(database.causalAccountDao().update(updated) == 1) { "The causal account disappeared." }
            }
            return@withTransaction NativeCausalProjectionResult(epoch, revision, generation - 1, duplicate, result.reviews.toString())
        }
        val updated = entity.copy(payload = state.toString())
        NativeCausalJournal.validate(updated)
        check(database.causalAccountDao().update(updated) == 1) { "The causal account disappeared." }
        database.rawCollectionDao().insert(mirror.copy(payload = state.getJSONObject("tracking").toString(),
            updatedAt = ActionJson.instantFormatter.format(Instant.now())))
        NativeCausalProjectionResult(epoch, revision, generation, false, result.reviews.toString())
    }
}
