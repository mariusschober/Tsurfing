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
        if (savedRequest.toByteArray(Charsets.UTF_8).size > 256 * 1024) throw NativeCausalTransportException(413, false)
        val operation = NativeCausalProtocol.operation(accountId, JSONObject(savedRequest))
        val response = request("/api/v1/sync/actions", "POST", savedRequest)
        if (response.code !in 200..299) throw NativeCausalTransportException(response.code,
            response.code in setOf(408, 425, 429) || response.code >= 500)
        if (response.body.toByteArray(Charsets.UTF_8).size > 8 * 1024 * 1024) {
            throw NativeSyncProtocolException("The causal response exceeded the safe client limit.")
        }
        return NativeCausalProtocol.receipt(accountId, operation, JSONObject(response.body))
    }
}
