package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.NativeCausalProtocol
import com.mariusschober.goalflow.nativeapp.data.ActionJson
import com.mariusschober.goalflow.nativeapp.data.NativeCausalHistoryPosition
import com.mariusschober.goalflow.nativeapp.data.NativeCausalHistoryProtocol
import org.json.JSONObject

class NativeCausalTransportException(val status: Int, val retryable: Boolean) : IllegalStateException(
    if (retryable) "Retry the exact saved causal action." else "The saved causal action needs review. Retain its original contents."
)

/** One attempt only. The owning coordinator must durably save the request
 * first, bind authentication, and commit verified history before retirement. */
object NativeCausalTransport {
    fun history(accountId: String, position: NativeCausalHistoryPosition,
        request: (String, String, String?) -> NativeHttpResponse): JSONObject {
        position.validate()
        require(ActionJson.identity(accountId)) { "Invalid causal history account." }
        val response = request("/api/v1/sync/causal-history?epoch=${position.epoch}&revision=${position.revision}&throughRevision=${position.throughRevision}&offset=${position.offset}", "GET", null)
        if (response.code !in 200..299) throw NativeCausalTransportException(response.code,
            response.code in setOf(408, 425, 429) || response.code >= 500)
        if (response.body.toByteArray(Charsets.UTF_8).size > 72 * 1024) throw NativeSyncProtocolException("The causal history response exceeded the safe client limit.")
        return NativeCausalHistoryProtocol.chunk(accountId, position, JSONObject(response.body))
    }

    fun send(accountId: String, savedRequest: String, request: (String, String, String) -> NativeHttpResponse): JSONObject {
        val operation = prepared(accountId, savedRequest)
        if (operation.opt("type") == "completion") {
            val upload = ReconciliationUpload.prepareBody(savedRequest)
            for (chunk in upload.chunks) verifyChunk(chunk, request("/api/v1/sync/conflicts/stage", "POST", chunk.toString()))
            return received(accountId, operation, request(if (upload.manifest == null) "/api/v1/sync/complete-focus" else "/api/v1/sync/complete-focus-staged",
                "POST", upload.manifest?.toString() ?: savedRequest))
        }
        return received(accountId, operation, request("/api/v1/sync/actions", "POST", savedRequest))
    }

    suspend fun sendBound(accountId: String, savedRequest: String,
        request: suspend (String, String, String?) -> NativeHttpResponse): JSONObject {
        val operation = prepared(accountId, savedRequest)
        if (operation.opt("type") == "completion") {
            val upload = ReconciliationUpload.prepareBody(savedRequest)
            for (chunk in upload.chunks) verifyChunk(chunk, request("/api/v1/sync/conflicts/stage", "POST", chunk.toString()))
            return received(accountId, operation, request(if (upload.manifest == null) "/api/v1/sync/complete-focus" else "/api/v1/sync/complete-focus-staged",
                "POST", upload.manifest?.toString() ?: savedRequest))
        }
        return received(accountId, operation, request("/api/v1/sync/actions", "POST", savedRequest))
    }

    private fun verifyChunk(chunk: JSONObject, response: NativeHttpResponse) {
        if (response.code !in 200..299) throw NativeCausalTransportException(response.code,
            response.code in setOf(408, 425, 429) || response.code >= 500)
        require(response.body.toByteArray(Charsets.UTF_8).size <= 16 * 1024) { "The completion chunk acknowledgment exceeded its envelope." }
        ReconciliationUpload.verifyAck(chunk, response.body)
    }

    private fun prepared(accountId: String, savedRequest: String): JSONObject {
        val value = JSONObject(savedRequest)
        val completion = value.opt("type") == "completion"
        if (savedRequest.toByteArray(Charsets.UTF_8).size > if (completion) 4 * 1024 * 1024 else 256 * 1024) throw NativeCausalTransportException(413, false)
        return if (completion) NativeCausalProtocol.completion(accountId, value) else NativeCausalProtocol.operation(accountId, value)
    }

    private fun received(accountId: String, operation: JSONObject, response: NativeHttpResponse): JSONObject {
        if (response.code !in 200..299) throw NativeCausalTransportException(response.code,
            response.code in setOf(408, 425, 429) || response.code >= 500)
        if (response.body.toByteArray(Charsets.UTF_8).size > if (operation.opt("type") == "completion") 16 * 1024 * 1024 else 8 * 1024 * 1024) {
            throw NativeSyncProtocolException("The causal response exceeded the safe client limit.")
        }
        return if (operation.opt("type") == "completion") NativeCausalProtocol.completionReceipt(accountId, operation, JSONObject(response.body))
            else NativeCausalProtocol.receipt(accountId, operation, JSONObject(response.body))
    }
}
