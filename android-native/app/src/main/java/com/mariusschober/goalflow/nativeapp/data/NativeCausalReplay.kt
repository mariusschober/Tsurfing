package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject

data class NativeCausalReplayResult(val tracking: JSONObject, val focus: JSONObject,
    val baselines: JSONObject, val events: JSONObject, val receipts: JSONObject)

/** Reconstruct the complete downloaded prefix before changing local authority.
 * A valid receipt shape alone is not proof of counter or focus conservation. */
object NativeCausalReplay {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    private fun values(objectValue: JSONObject) = JSONArray(objectValue.keys().asSequence().map { objectValue.getJSONObject(it) }.toList())

    fun replay(accountId: String, history: JSONObject): NativeCausalReplayResult {
        return replayAt(accountId, history, history.getLong("downloadedRevision"))
    }

    /** Local admissions retain the revision they observed. Reconstruct that
     * basis even after later entries arrive, without trimming retained evidence
     * or borrowing a newer causal parent. The entire saved envelope is still
     * validated; selecting a prefix must not hide damaged retained bytes. */
    fun replayAt(accountId: String, history: JSONObject, revision: Long): NativeCausalReplayResult {
        NativeSavedCausalHistory.validate(accountId, history)
        val downloaded = history.getLong("downloadedRevision")
        require(revision in 0..downloaded) { "The requested causal basis has not been downloaded." }
        val entries = history.getJSONObject("entries"); val epoch = history.getString("epoch")
        val first = NativeCausalHistoryProtocol.entry(accountId, epoch, 0, JSONObject(entries.getJSONObject("0").getString("body")))
        val initialReceipt = first.getJSONObject("receipt")
        var tracking = JSONObject(initialReceipt.getJSONObject("record").getJSONObject("payload").toString())
        var focus = CausalFocus.initial(accountId, if (!tracking.has("focusSession") || tracking.isNull("focusSession")) null else tracking.getJSONObject("focusSession"))
        val baseline = initialReceipt.getJSONObject("baseline")
        val baselines = JSONObject().put(baseline.getString("day"), baseline)
        val events = JSONObject(); val receipts = JSONObject(); val members = mutableSetOf<String>()
        fun baselineIdentity(id: String) = baselines.keys().asSequence().any { baselines.getJSONObject(it).getString("baselineId") == id }
        for (entryRevision in 1..revision) {
            val entry = NativeCausalHistoryProtocol.entry(accountId, epoch, entryRevision, JSONObject(entries.getJSONObject(entryRevision.toString()).getString("body")))
            val receipt = entry.getJSONObject("receipt"); val operation = receipt.getJSONObject("operation")
            val command = operation.getJSONObject("command"); val id = command.getString("actionId")
            require(!receipts.has(id) && id !in members && id != epoch && !baselineIdentity(id)) { "History repeats an immutable action identity." }
            if (operation.getString("type") == "completion") {
                val changes = operation.getJSONArray("changes")
                for (index in 0 until changes.length()) {
                    val member = changes.getJSONObject(index).getString("mutationId")
                    require(!receipts.has(member) && member !in members && member != epoch && !baselineIdentity(member)) { "History reuses a completion member identity." }
                    if (receipt.getBoolean("accepted")) members.add(member)
                }
            }
            when (operation.getString("type")) {
                "focus", "completion" -> {
                    val result = CausalFocus.apply(focus, command)
                    require(same(result.outcome, receipt.getJSONObject("outcome"))) { "History contradicts its focus transition." }
                    focus = result.journal
                    if (result.outcome.getBoolean("accepted")) tracking.put("focusSession",
                        focus.getJSONObject("sessions").getJSONObject(focus.getString("currentSessionId")).getJSONObject("projection"))
                }
                "counter" -> {
                    val day = command.getString("day")
                    val established = baselines.optJSONObject(day) ?: error("History is missing an established counter day.")
                    events.put(id, command)
                    val counts = CounterLedger.project(established, values(events))
                    require(same(counts, receipt.getJSONObject("outcome").getJSONObject("counts"))) { "History violates counter conservation." }
                    if (tracking.opt("date") == day) tracking.put("planViewCount", counts.get("planViewCount"))
                        .put("dailyPostponeCount", counts.get("dailyPostponeCount"))
                }
                "counterDay" -> {
                    val established = receipt.getJSONObject("baseline"); val day = established.getString("day")
                    val prior = baselines.optJSONObject(day)
                    require(prior == null || same(prior, established)) { "History rewrites a counter baseline." }
                    val baselineId = established.getString("baselineId")
                    require(prior != null || (!receipts.has(baselineId) && baselineId != id && baselineId !in members
                        && baselineId != epoch && !baselineIdentity(baselineId))) { "History reuses an immutable identity as baseline evidence." }
                    baselines.put(day, established)
                    val counts = CounterLedger.project(established, values(events))
                    require(same(counts, receipt.getJSONObject("counts"))) { "History violates counter day conservation." }
                    if (command.getString("kind") == "select") tracking.put("date", day)
                        .put("planViewCount", counts.get("planViewCount")).put("dailyPostponeCount", counts.get("dailyPostponeCount"))
                }
            }
            require(same(NativeCausalJournal.protectedTracking(tracking),
                NativeCausalJournal.protectedTracking(receipt.getJSONObject("record").getJSONObject("payload")))) {
                "History changes unrelated protected tracking state."
            }
            receipts.put(id, receipt)
            tracking = JSONObject(receipt.getJSONObject("record").getJSONObject("payload").toString())
        }
        return NativeCausalReplayResult(tracking, focus, baselines, events, receipts)
    }
}
