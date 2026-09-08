package com.mariusschober.goalflow.nativeapp.data

import androidx.room.withTransaction
import org.json.JSONArray
import org.json.JSONObject

/** Download evidence only. Projection replay and exact outbox retirement are
 * separate transactions and cannot infer acceptance from this cursor. */
object NativeSavedCausalHistory {
    fun validate(accountId: String, history: JSONObject) {
        val through = ActionJson.integer(history.opt("throughRevision"))
        val downloaded = ActionJson.integer(history.opt("downloadedRevision"))
        require(ActionJson.integer(history.opt("schemaVersion")) == 1L && ActionJson.identity(history.opt("epoch"))
            && through != null && through >= 0 && downloaded != null && downloaded in -1..through) { "Invalid retained history position." }
        val epoch = history.getString("epoch"); val entries = history.getJSONObject("entries")
        require(entries.length().toLong() == downloaded + 1) { "Retained history has missing revisions." }
        for (revision in 0..downloaded) {
            val saved = entries.getJSONObject(revision.toString()); val body = saved.getString("body")
            val bytes = body.toByteArray(Charsets.UTF_8)
            require(bytes.size <= NativeCausalHistoryProtocol.MAX_ENTRY_BYTES && NativeCausalHistoryProtocol.hash(bytes) == saved.opt("sha256")) { "Retained history checksum differs." }
            NativeCausalHistoryProtocol.entry(accountId, epoch, revision, JSONObject(body))
        }
        if (history.has("partial")) {
            val chunks = history.getJSONArray("partial")
            require(chunks.length() in 1..((NativeCausalHistoryProtocol.MAX_ENTRY_BYTES + NativeCausalHistoryProtocol.CHUNK_BYTES - 1) / NativeCausalHistoryProtocol.CHUNK_BYTES)) { "Invalid partial history." }
            var offset = 0; var hash: String? = null; var total: Int? = null
            for (index in 0 until chunks.length()) {
                val chunk = NativeCausalHistoryProtocol.chunk(accountId, NativeCausalHistoryPosition(epoch, downloaded + 1, through, offset), chunks.getJSONObject(index))
                if (hash == null) { hash = chunk.getString("sha256"); total = chunk.getInt("totalBytes") }
                require(hash == chunk.getString("sha256") && total == chunk.getInt("totalBytes") && !chunk.isNull("nextOffset")) { "Partial history manifest differs." }
                offset = chunk.getInt("nextOffset")
            }
        }
    }

    fun next(history: JSONObject): NativeCausalHistoryPosition? {
        val downloaded = history.getLong("downloadedRevision"); val through = history.getLong("throughRevision")
        if (downloaded == through) return null
        val partial = history.optJSONArray("partial")
        val offset = partial?.getJSONObject(partial.length() - 1)?.getInt("nextOffset") ?: 0
        return NativeCausalHistoryPosition(history.getString("epoch"), downloaded + 1, through, offset)
    }
}

class NativeCausalHistoryStore(private val database: GoalflowDatabase) {
    suspend fun resumeOrBegin(accountId: String, epoch: String, throughRevision: Long) {
        val previous = database.withTransaction {
            val (_, state) = state(accountId)
            state.optJSONObject("causalHistory")?.let { JSONObject(it.toString()) }
        }
        if (previous == null) begin(accountId, epoch, throughRevision)
        else require(previous.opt("epoch") == epoch && previous.getLong("throughRevision") <= throughRevision) { "The history frontier cannot be rewound." }
    }

    private suspend fun state(accountId: String): Pair<CausalAccountEntity, JSONObject> {
        require(database.localAccountDao().get()?.userId == accountId) { "History account differs from the bound database." }
        val entity = database.causalAccountDao().get(accountId) ?: error("Causal account preparation is required.")
        return entity to NativeCausalJournal.validate(entity)
    }

    suspend fun begin(accountId: String, epoch: String, throughRevision: Long) = database.withTransaction {
        NativeCausalHistoryPosition(epoch, 0, throughRevision).validate()
        val (entity, state) = state(accountId)
        val history = state.optJSONObject("causalHistory") ?: JSONObject().put("schemaVersion", 1)
            .put("epoch", epoch).put("throughRevision", throughRevision).put("downloadedRevision", -1).put("entries", JSONObject())
        require(history.getString("epoch") == epoch && throughRevision >= history.getLong("throughRevision")) { "The retained history epoch or frontier cannot be replaced." }
        require(!history.has("partial") || throughRevision == history.getLong("throughRevision")) { "Finish the pinned history entry before extending its frontier." }
        history.put("throughRevision", throughRevision)
        NativeSavedCausalHistory.validate(accountId, history)
        state.put("causalHistory", history)
        NativeCausalEnrollmentProtocol.validate(accountId, state)
        check(database.causalAccountDao().update(entity.copy(payload = state.toString())) == 1)
    }

    suspend fun next(accountId: String): NativeCausalHistoryPosition? = database.withTransaction {
        val (_, state) = state(accountId)
        NativeSavedCausalHistory.next(state.getJSONObject("causalHistory"))
    }

    suspend fun accept(accountId: String, position: NativeCausalHistoryPosition, supplied: JSONObject) {
        val captured = JSONObject(supplied.toString())
        NativeCausalHistoryProtocol.chunk(accountId, position, captured)
        database.withTransaction {
            val (entity, state) = state(accountId); val history = state.getJSONObject("causalHistory")
            require(NativeSavedCausalHistory.next(history) == position) { "The history download position changed. Retry from the retained cursor." }
            val partial = history.optJSONArray("partial") ?: JSONArray()
            partial.put(captured)
            if (captured.isNull("nextOffset")) {
                val body = NativeCausalHistoryProtocol.assemble(accountId, position.copy(offset = 0),
                    (0 until partial.length()).map { partial.getJSONObject(it) })
                history.getJSONObject("entries").put(position.revision.toString(), JSONObject().put("body", body)
                    .put("sha256", NativeCausalHistoryProtocol.hash(body.toByteArray(Charsets.UTF_8))))
                history.put("downloadedRevision", position.revision).remove("partial")
            } else history.put("partial", partial)
            NativeSavedCausalHistory.validate(accountId, history)
            if (history.getLong("downloadedRevision") >= 0) NativeCausalReplay.replay(accountId, history)
            check(database.causalAccountDao().update(entity.copy(payload = state.toString())) == 1)
        }
    }
}
