package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject

class NativeCompletionReview(val actionId: String, val code: String, val entityKey: String) : IllegalStateException(
    "Completion needs recovery review before applying its final effects. Original versions remain retained."
)

object NativeCompletionApplicationEvidence {
    fun validate(state: JSONObject) {
        val applications = if (state.has("completionApplications")) state.getJSONObject("completionApplications") else JSONObject()
        for (id in applications.keys()) {
            val application = applications.getJSONObject(id)
            val sequence = ActionJson.integer(application.opt("sequence"))
            val revision = ActionJson.integer(application.opt("revision"))
            require(sequence != null && revision != null && revision > 0) { "Invalid completion application position." }
            val history = state.getJSONObject("causalHistory")
            val saved = history.getJSONObject("entries").getJSONObject(revision.toString())
            val receipt = JSONObject(saved.getString("body")).getJSONObject("receipt")
            val projection = state.getJSONObject("projectionAdmissions").getJSONObject(sequence.toString())
            require(application.keys().asSequence().toSet() == setOf("sequence", "epoch", "revision", "sha256", "members")
                && application.opt("epoch") == history.opt("epoch") && application.opt("sha256") == saved.opt("sha256")
                && projection.opt("epoch") == application.opt("epoch") && projection.getLong("revision") >= revision
                && receipt.getJSONObject("operation").opt("type") == "completion"
                && receipt.getJSONObject("operation").getJSONObject("command").opt("actionId") == id && receipt.getBoolean("accepted")) {
                "The completion application differs from its applied history proof."
            }
            val changes = receipt.getJSONObject("operation").getJSONArray("changes")
            val members = application.getJSONObject("members")
            require(members.length() == changes.length()) { "The completion application has incomplete members." }
            for (index in 0 until changes.length()) {
                val member = changes.getJSONObject(index); val key = member.getString("entityType") + ":" + member.getString("entityId")
                val decision = members.getJSONObject(key); val serverBefore = ActionJson.integer(decision.opt("serverVersionBefore"))
                val localBefore = ActionJson.integer(decision.opt("localVersionBefore"))
                val serverAfter = receipt.getJSONArray("changes").getJSONObject(index).getLong("serverVersion")
                require(decision.keys().asSequence().toSet() == setOf("decision", "preimage", "serverVersionBefore", "localVersionBefore")
                    && serverBefore != null && serverBefore >= 0 && localBefore != null && localBefore >= 0
                    && decision.opt("decision") in setOf("applied", "represented")
                    && (if (decision.getString("decision") == "represented") serverBefore >= serverAfter else serverBefore < serverAfter)
                    && (decision.isNull("preimage") || decision.opt("preimage") is String)) {
                    "The completion member decision differs from its receipt."
                }
            }
        }
        val reviews = if (state.has("completionApplicationReviews")) state.getJSONObject("completionApplicationReviews") else JSONObject()
        for (key in reviews.keys()) {
            val review = reviews.getJSONObject(key); val revision = ActionJson.integer(review.opt("revision"))
            require(revision != null && revision > 0 && key == ActionJson.canonical(review)) { "Invalid completion review position." }
            val history = state.getJSONObject("causalHistory"); val entry = history.getJSONObject("entries").getJSONObject(revision.toString())
            val operation = JSONObject(entry.getString("body")).getJSONObject("receipt").getJSONObject("operation")
            require(review.keys().asSequence().toSet() == setOf("actionId", "epoch", "revision", "sha256", "code", "entityKey")
                && review.opt("epoch") == history.opt("epoch") && review.opt("sha256") == entry.opt("sha256")
                && operation.opt("type") == "completion" && review.opt("actionId") == operation.getJSONObject("command").opt("actionId")
                && review.opt("code") in setOf("COMPLETION_MEMBER_REVIEW", "COMPLETION_LOCAL_REVIEW", "COMPLETION_BASE_REQUIRED", "COMPLETION_PROJECTION_MISMATCH")
                && (0 until operation.getJSONArray("changes").length()).any {
                    val member = operation.getJSONArray("changes").getJSONObject(it)
                    review.opt("entityKey") == member.getString("entityType") + ":" + member.getString("entityId")
                }) { "The completion review differs from retained history." }
        }
    }

    fun requireApplied(state: JSONObject, id: String, receipt: JSONObject, sequence: Long) {
        val application = state.optJSONObject("completionApplications")?.optJSONObject(id)
            ?: error("Atomic completion member application is required before this history can be applied.")
        require(application.getLong("sequence") <= sequence && application.getLong("revision") == receipt.getLong("projectionRevision")) {
            "The completion effects were not represented in this local projection basis."
        }
    }
}

/** The caller owns one Room transaction spanning these typed business writes,
 * causal evidence and tracking. Exact receipt payloads stay in history; typed
 * replica comparison uses the existing native codec, never a rewritten receipt. */
class NativeCausalCompletionProjection(private val database: GoalflowDatabase,
    private val readPayload: suspend (String, String) -> String?,
    private val nativePayload: (String, String) -> String,
    private val applyRecord: suspend (NativeRemoteRecord) -> Unit) {
    suspend fun apply(state: JSONObject, canonical: NativeCausalReplayResult, sequence: Long) {
        val history = state.getJSONObject("causalHistory")
        val applications = state.optJSONObject("completionApplications") ?: JSONObject()
        for (id in canonical.receipts.keys().asSequence().toList().sortedBy { canonical.receipts.getJSONObject(it).getLong("projectionRevision") }) {
            val receipt = canonical.receipts.getJSONObject(id); val operation = receipt.getJSONObject("operation")
            if (operation.getString("type") != "completion" || !receipt.getBoolean("accepted")) continue
            val revision = receipt.getLong("projectionRevision")
            val proof = history.getJSONObject("entries").getJSONObject(revision.toString())
            val decisions = JSONObject(); val changes = operation.getJSONArray("changes")
            for (index in 0 until changes.length()) {
                val member = changes.getJSONObject(index); val result = receipt.getJSONArray("changes").getJSONObject(index)
                val type = member.getString("entityType"); val entityId = member.getString("entityId"); val key = "$type:$entityId"
                val meta = database.syncMetaDao().get(key)
                    ?: if (type in setOf("stats", "progress")) database.syncMetaDao().get(type) else null
                val serverBefore = meta?.serverVersion ?: 0L; val localBefore = meta?.localVersion ?: 0L
                val serverAfter = result.getLong("serverVersion")
                val current = readPayload(type, entityId)
                val pending = database.syncOutboxDao().getForEntity(type, entityId).isNotEmpty()
                    || database.syncOutboxDao().get(member.getString("mutationId")) != null
                    || database.syncConflictDao().getUnresolved(type, entityId) != null
                val decision: String
                if (serverBefore >= serverAfter) {
                    if (serverBefore == serverAfter && !pending) {
                        val expected = try { nativePayload(type, member.getJSONObject("payload").toString()) }
                            catch (_: IllegalArgumentException) { throw NativeCompletionReview(id, "COMPLETION_MEMBER_REVIEW", key) }
                        if (current == null || ActionJson.canonical(JSONObject(current)) != ActionJson.canonical(JSONObject(expected))) {
                            throw NativeCompletionReview(id, "COMPLETION_PROJECTION_MISMATCH", key)
                        }
                    }
                    decision = "represented"
                } else {
                    if (pending) throw NativeCompletionReview(id, "COMPLETION_LOCAL_REVIEW", key)
                    val emptyDefault = current?.let { bytes -> runCatching {
                        val value = JSONObject(bytes)
                        type == "stats" && value.length() == 0 || type == "progress" && ActionJson.canonical(value) ==
                            ActionJson.canonical(JSONObject().put("level", 1).put("xp", 0).put("xpToNextLevel", 100))
                    }.getOrDefault(false) } == true
                    if (serverBefore == 0L && (localBefore > 0 || current != null && !emptyDefault)) {
                        throw NativeCompletionReview(id, "COMPLETION_BASE_REQUIRED", key)
                    }
                    // Validate native materialization before touching this member.
                    try { nativePayload(type, member.getJSONObject("payload").toString()) }
                    catch (_: IllegalArgumentException) { throw NativeCompletionReview(id, "COMPLETION_MEMBER_REVIEW", key) }
                    val record = result.getJSONObject("record")
                    applyRecord(NativeRemoteRecord(type, entityId, record.getLong("version"), serverAfter,
                        record.getString("device_id"), record.getJSONObject("payload").toString(), record.getString("updated_at"), null))
                    decision = "applied"
                }
                decisions.put(key, JSONObject().put("decision", decision).put("preimage", current ?: JSONObject.NULL)
                    .put("serverVersionBefore", serverBefore).put("localVersionBefore", localBefore))
                database.syncMetaDao().insert(SyncMetaEntity(key, meta?.cursor ?: 0L,
                    maxOf(localBefore, member.getLong("version")), maxOf(serverBefore, serverAfter), meta?.lastSuccessfulSync))
            }
            if (!applications.has(id)) applications.put(id, JSONObject().put("sequence", sequence).put("epoch", history.getString("epoch"))
                .put("revision", revision).put("sha256", proof.getString("sha256")).put("members", decisions))
        }
        if (applications.length() > 0) state.put("completionApplications", applications)
    }
}
