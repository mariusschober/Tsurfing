package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import java.time.Instant

class NativeCausalHistoryRequired : IllegalStateException("Refresh causal history before applying this tracking snapshot. The pull cursor is retained.")

/** Ordinary tracking rows are observations, never new counter or focus
 * commands. Preserve the complete row and its causal basis before advancing
 * the ordinary cursor; pending local projections remain authoritative locally. */
object NativeTrackingPullEvidence {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    fun record(value: NativeRemoteRecord): JSONObject = JSONObject().put("entityType", value.entityType).put("entityId", value.entityId)
        .put("version", value.version).put("serverVersion", value.serverVersion).put("deviceId", value.deviceId)
        .put("payload", value.payload).put("updatedAt", value.updatedAt).put("deletedAt", value.deletedAt ?: JSONObject.NULL)

    private fun decision(accountId: String, state: JSONObject, row: JSONObject, basis: Long): Pair<String, Long?> {
        require(row.keys().asSequence().toSet() == setOf("entityType", "entityId", "version", "serverVersion", "deviceId", "payload", "updatedAt", "deletedAt")
            && row.opt("entityType") == "tracking" && row.opt("entityId") == "singleton"
            && ActionJson.integer(row.opt("version"))?.let { it >= 0 } == true
            && ActionJson.integer(row.opt("serverVersion"))?.let { it > 0 } == true
            && row.opt("deviceId") is String && row.getString("deviceId").isNotBlank()
            && row.opt("payload") is String && row.has("deletedAt") && row.isNull("deletedAt")) { "Invalid causal tracking observation." }
        Instant.parse(row.getString("updatedAt"))
        val payload = JSONObject(row.getString("payload"))
        val entries = state.getJSONObject("causalHistory").getJSONObject("entries")
        val canonical = NativeCausalReplay.replayAt(accountId, state.getJSONObject("causalHistory"), basis)
        val latest = JSONObject(entries.getJSONObject(basis.toString()).getString("body")).getJSONObject("receipt").getJSONObject("record")
        for (revision in 0..basis) {
            val proof = JSONObject(entries.getJSONObject(revision.toString()).getString("body")).getJSONObject("receipt").getJSONObject("record")
            if (proof.getLong("server_version") != row.getLong("serverVersion")) continue
            require(proof.opt("user_id") == accountId && proof.opt("entity_type") == "tracking" && proof.opt("entity_id") == "singleton"
                && proof.getLong("version") == row.getLong("version") && proof.opt("device_id") == row.opt("deviceId")
                && same(proof.opt("payload"), payload) && proof.has("deleted_at") && proof.isNull("deleted_at")
                && Instant.parse(proof.getString("updated_at")) == Instant.parse(row.getString("updatedAt"))) {
                "The tracking row differs from its exact history revision."
            }
            return "history" to revision
        }
        if (row.getLong("serverVersion") < latest.getLong("server_version")) return "superseded_legacy_review" to null
        if (same(NativeCausalJournal.protectedTracking(payload), NativeCausalJournal.protectedTracking(canonical.tracking))) {
            return "unchanged_protected" to null
        }
        throw NativeCausalHistoryRequired()
    }

    fun retain(accountId: String, state: JSONObject, supplied: NativeRemoteRecord) {
        val basis = NativeCausalRequestJournal.appliedRevision(state)
        if (basis < 0) throw NativeCausalHistoryRequired()
        val row = record(supplied); val (decision, revision) = decision(accountId, state, row, basis)
        val observations = state.optJSONObject("trackingPullObservations") ?: JSONObject()
        val key = supplied.serverVersion.toString()
        if (observations.has(key)) {
            require(same(observations.getJSONObject(key).getJSONObject("record"), row)) { "A retained tracking observation is immutable." }
            return
        }
        observations.put(key, JSONObject().put("accountId", accountId).put("basisRevision", basis).put("matchedRevision", revision ?: JSONObject.NULL)
            .put("decision", decision).put("record", row).put("preimage", state.getJSONObject("tracking").toString()))
        state.put("trackingPullObservations", observations)
        val latest = JSONObject(state.getJSONObject("causalHistory").getJSONObject("entries").getJSONObject(basis.toString()).getString("body"))
            .getJSONObject("receipt").getJSONObject("record").getLong("server_version")
        val newestObserved = observations.keys().asSequence().maxOf { it.toLong() }
        if (supplied.serverVersion >= maxOf(latest, newestObserved)) {
            val next = JSONObject(supplied.payload); val protected = NativeCausalJournal.protectedTracking(state.getJSONObject("tracking"))
            for (keyName in listOf("date", "planViewCount", "dailyPostponeCount", "focusSession")) {
                if (protected.has(keyName)) next.put(keyName, protected.get(keyName)) else next.remove(keyName)
            }
            state.put("tracking", next)
        }
    }

    fun validate(accountId: String, state: JSONObject) {
        val observations = state.optJSONObject("trackingPullObservations") ?: return
        for (key in observations.keys()) {
            val entry = observations.getJSONObject(key); val basis = ActionJson.integer(entry.opt("basisRevision"))
            require(entry.keys().asSequence().toSet() == setOf("accountId", "basisRevision", "matchedRevision", "decision", "record", "preimage")
                && entry.opt("accountId") == accountId && basis != null && basis in 0..NativeCausalRequestJournal.appliedRevision(state)
                && entry.opt("preimage") is String && key == entry.getJSONObject("record").getLong("serverVersion").toString()) {
                "The retained tracking observation has an invalid basis."
            }
            JSONObject(entry.getString("preimage"))
            val (decision, revision) = decision(accountId, state, entry.getJSONObject("record"), basis)
            require(entry.opt("decision") == decision && same(entry.opt("matchedRevision"), revision ?: JSONObject.NULL)) {
                "The tracking observation differs from its retained history basis."
            }
        }
    }
}
