package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject
import org.json.JSONTokener
import java.time.Instant

/** Exact ordinary predecessor receipts remain available after outbox retirement
 * so completion can resolve a base version without guessing from a cursor. */
object NativeLegacyReceiptEvidence {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    private fun field(value: JSONObject, camel: String, snake: String): Any? {
        if (value.has(camel) && value.has(snake)) require(same(value.get(camel), value.get(snake))) { "Conflicting receipt aliases." }
        require(value.has(camel) || value.has(snake)) { "Incomplete predecessor receipt." }
        return if (value.has(camel)) value.get(camel) else value.get(snake)
    }
    private fun instant(value: Any?): Instant? = if (value == null || value == JSONObject.NULL) null else {
        require(value is String) { "Invalid predecessor timestamp." }; Instant.parse(value)
    }
    fun queued(value: SyncOutboxEntity): JSONObject = JSONObject().put("mutationId", value.mutationId).put("deviceId", value.deviceId)
        .put("entityType", value.entityType).put("entityId", value.entityId).put("baseServerVersion", value.baseServerVersion ?: JSONObject.NULL)
        .put("version", value.version).put("payload", value.payload).put("updatedAt", value.updatedAt).put("deletedAt", value.deletedAt ?: JSONObject.NULL)
        .put("dependsOnMutationId", value.dependsOnMutationId ?: JSONObject.NULL).put("resolvesConflictId", value.resolvesConflictId ?: JSONObject.NULL)
        .put("attemptedAt", value.attemptedAt ?: JSONObject.NULL)

    fun validateReceipt(accountId: String, request: JSONObject, receipt: JSONObject) {
        val version = ActionJson.integer(receipt.opt("serverVersion"))
        require(request.keys().asSequence().toSet() == setOf("mutationId", "deviceId", "entityType", "entityId", "baseServerVersion",
            "version", "payload", "updatedAt", "deletedAt", "dependsOnMutationId", "resolvesConflictId", "attemptedAt")
            && listOf("deviceId", "entityType", "entityId").all { request.opt(it) is String && request.getString(it).isNotBlank() }
            && ActionJson.integer(request.opt("version"))?.let { it > 0 } == true
            && (request.isNull("baseServerVersion") || ActionJson.integer(request.opt("baseServerVersion"))?.let { it >= 0 } == true)
            && listOf("dependsOnMutationId", "resolvesConflictId").all { request.isNull(it) || ActionJson.identity(request.opt(it)) }
            && listOf("replayMismatch", "serverMissing").all { !receipt.has(it) || receipt.opt(it) is Boolean }) { "Invalid predecessor request evidence." }
        instant(request.get("attemptedAt"))
        val parser = JSONTokener(request.getString("payload")); val payload = parser.nextValue()
        require(parser.nextClean() == '\u0000') { "The predecessor payload contains trailing data." }
        require(ActionJson.identity(accountId) && ActionJson.identity(request.opt("mutationId"))
            && receipt.opt("mutationId") == request.opt("mutationId") && receipt.opt("accepted") == true
            && version != null && version > 0 && receipt.opt("replayMismatch") != true && receipt.opt("serverMissing") != true
            && (!receipt.has("conflictId") || receipt.isNull("conflictId"))) { "Invalid accepted predecessor receipt." }
        val record = receipt.getJSONObject("record")
        require(field(record, "userId", "user_id") == accountId
            && field(record, "entityType", "entity_type") == request.opt("entityType")
            && field(record, "entityId", "entity_id") == request.opt("entityId")
            && field(record, "deviceId", "device_id") == request.opt("deviceId")
            && ActionJson.integer(record.opt("version")) == ActionJson.integer(request.opt("version"))
            && ActionJson.integer(record.opt("version"))?.let { it > 0 } == true
            && ActionJson.integer(field(record, "serverVersion", "server_version")) == version
            && same(record.get("payload"), payload)
            && instant(field(record, "updatedAt", "updated_at")) == Instant.parse(request.getString("updatedAt"))
            && instant(field(record, "deletedAt", "deleted_at")) == instant(request.get("deletedAt"))) {
            "The predecessor receipt does not prove the exact original request and account."
        }
    }

    fun validate(accountId: String, state: JSONObject) {
        if (!state.has("legacyPushReceipts")) return
        val receipts = state.getJSONObject("legacyPushReceipts")
        for (id in receipts.keys()) {
            val entry = receipts.getJSONObject(id); val request = entry.getJSONObject("request")
            require(entry.keys().asSequence().toSet() == setOf("request", "receipt") && request.opt("mutationId") == id) {
                "The predecessor evidence identity differs."
            }
            validateReceipt(accountId, request, JSONObject(entry.getString("receipt")))
        }
    }

    fun retain(accountId: String, state: JSONObject, request: SyncOutboxEntity, rawReceipt: String) {
        val captured = queued(request); val receipt = JSONObject(rawReceipt)
        validateReceipt(accountId, captured, receipt)
        val receipts = state.optJSONObject("legacyPushReceipts") ?: JSONObject()
        val previous = receipts.optJSONObject(request.mutationId)
        if (previous != null) {
            // attemptedAt is local transport bookkeeping; all original queued
            // request fields and exact receipt meaning remain immutable.
            val priorRequest = JSONObject(previous.getJSONObject("request").toString()).apply { remove("attemptedAt") }
            val nextRequest = JSONObject(captured.toString()).apply { remove("attemptedAt") }
            require(same(priorRequest, nextRequest) && same(JSONObject(previous.getString("receipt")), receipt)) {
                "The retained predecessor evidence is immutable."
            }
        } else receipts.put(request.mutationId, JSONObject().put("request", captured).put("receipt", rawReceipt))
        state.put("legacyPushReceipts", receipts)
    }
}
