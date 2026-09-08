package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

data class NativeCausalHistoryPosition(val epoch: String, val revision: Long, val throughRevision: Long, val offset: Int = 0) {
    fun validate() = require(ActionJson.identity(epoch) && revision in 0..throughRevision
        && throughRevision <= ActionJson.MAX_SAFE_INTEGER && offset in 0..NativeCausalHistoryProtocol.MAX_ENTRY_BYTES
        && offset % NativeCausalHistoryProtocol.CHUNK_BYTES == 0) { "Invalid causal history position." }
}

object NativeCausalHistoryProtocol {
    const val CHUNK_BYTES = 49152
    const val MAX_ENTRY_BYTES = 16 * 1024 * 1024
    fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    fun chunk(accountId: String, position: NativeCausalHistoryPosition, value: JSONObject): JSONObject {
        position.validate()
        val keys = setOf("schemaVersion", "accountId", "epoch", "revision", "throughRevision", "offset", "totalBytes", "sha256", "chunkSha256", "data", "nextOffset")
        val total = ActionJson.integer(value.opt("totalBytes"))
        require(value.keys().asSequence().toSet() == keys && ActionJson.identity(accountId)
            && ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("accountId") == accountId
            && value.opt("epoch") == position.epoch && ActionJson.integer(value.opt("revision")) == position.revision
            && ActionJson.integer(value.opt("throughRevision")) == position.throughRevision
            && ActionJson.integer(value.opt("offset")) == position.offset.toLong()
            && total != null && total in 1..MAX_ENTRY_BYTES && position.offset < total
            && value.opt("sha256") is String && Regex("^[a-f0-9]{64}$").matches(value.getString("sha256"))
            && value.opt("chunkSha256") is String && Regex("^[a-f0-9]{64}$").matches(value.getString("chunkSha256"))
            && value.opt("data") is String && value.getString("data").length <= 65536) { "The causal history chunk has a different identity or manifest." }
        val data = value.getString("data"); val bytes = Base64.getDecoder().decode(data)
        val length = minOf(CHUNK_BYTES, total.toInt() - position.offset)
        val next = (position.offset + length).takeIf { it < total }
        require(Base64.getEncoder().encodeToString(bytes) == data && bytes.size == length
            && (if (next == null) value.isNull("nextOffset") else ActionJson.integer(value.opt("nextOffset")) == next.toLong())
            && hash(bytes) == value.getString("chunkSha256")) { "The causal history chunk does not prove its requested bytes." }
        return value
    }

    fun entry(accountId: String, epoch: String, revision: Long, value: JSONObject): JSONObject {
        require(ActionJson.identity(accountId) && ActionJson.identity(epoch) && revision in 0..ActionJson.MAX_SAFE_INTEGER
            && ActionJson.integer(value.opt("schemaVersion")) == 2L && value.opt("accountId") == accountId
            && value.opt("epoch") == epoch && ActionJson.integer(value.opt("revision")) == revision) { "The causal history entry has a different identity." }
        val receipt = value.getJSONObject("receipt")
        if (revision == 0L) {
            val operation = receipt.getJSONObject("operation"); val record = receipt.getJSONObject("record"); val payload = record.getJSONObject("payload")
            val baseline = receipt.getJSONObject("baseline")
            require(ActionJson.integer(receipt.opt("schemaVersion")) == 2L && receipt.opt("epoch") == epoch
                && ActionJson.integer(receipt.opt("projectionRevision")) == 0L
                && ActionJson.integer(operation.opt("schemaVersion")) == 2L && operation.opt("accountId") == accountId && operation.opt("cutoverId") == epoch
                && record.opt("user_id") == accountId && record.opt("entity_type") == "tracking" && record.opt("entity_id") == "singleton"
                && ActionJson.integer(record.opt("version"))?.let { it > 0 } == true
                && ActionJson.integer(record.opt("server_version"))?.let { it > 0 } == true
                && record.opt("device_id") is String && record.getString("device_id").isNotEmpty()
                && record.has("deleted_at") && record.isNull("deleted_at") && record.opt("updated_at") is String
                && runCatching { Instant.parse(record.getString("updated_at")) }.isSuccess
                && ActionJson.integer(operation.opt("expectedTrackingServerVersion")) == ActionJson.integer(record.opt("server_version"))
                && ActionJson.canonical(operation.opt("expectedTrackingPayload")) == ActionJson.canonical(payload)) { "History does not prove the cutover record." }
            CounterLedger.project(baseline, JSONArray())
            require(baseline.opt("accountId") == accountId && baseline.opt("baselineId") == epoch && baseline.opt("day") == payload.opt("date")
                && listOf("planViewCount", "dailyPostponeCount").all { ActionJson.integer(baseline.getJSONObject("counts").opt(it)) == ActionJson.integer(payload.opt(it)) }
                && ActionJson.canonical(baseline.opt("evidenceIds")) == ActionJson.canonical(JSONArray().put(epoch))) { "History does not prove the cutover counts." }
        } else {
            val operation = receipt.getJSONObject("operation")
            require(operation.opt("epoch") == epoch && ActionJson.integer(receipt.opt("projectionRevision")) == revision) { "History receipt revision differs." }
            if (operation.opt("type") == "completion") NativeCausalProtocol.completionReceipt(accountId, operation, receipt)
            else NativeCausalProtocol.receipt(accountId, operation, receipt)
        }
        return value
    }

    /** No projection, acknowledgment or cursor changes occur before assembly. */
    fun assemble(accountId: String, position: NativeCausalHistoryPosition, chunks: List<JSONObject>): String {
        position.validate()
        require(position.offset == 0 && chunks.size in 1..((MAX_ENTRY_BYTES + CHUNK_BYTES - 1) / CHUNK_BYTES)) { "History entry is incomplete." }
        var body: ByteArray? = null; var expectedHash: String? = null; var offset: Int? = 0
        for (raw in chunks) {
            val current = offset ?: error("History contains extra chunks.")
            val item = chunk(accountId, position.copy(offset = current), raw)
            if (body == null) { body = ByteArray(item.getInt("totalBytes")); expectedHash = item.getString("sha256") }
            require(body.size == item.getInt("totalBytes") && expectedHash == item.getString("sha256")) { "History manifest changed." }
            Base64.getDecoder().decode(item.getString("data")).copyInto(body, current)
            offset = if (item.isNull("nextOffset")) null else item.getInt("nextOffset")
        }
        require(body != null && offset == null && hash(body) == expectedHash) { "History checksum is invalid or incomplete." }
        val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(body)).toString()
        entry(accountId, position.epoch, position.revision, JSONObject(decoded))
        return decoded
    }
}
