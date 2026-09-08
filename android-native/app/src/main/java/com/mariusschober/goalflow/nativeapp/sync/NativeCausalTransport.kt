package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.NativeCausalProtocol
import org.json.JSONObject

class NativeCausalTransportException(val status: Int, val retryable: Boolean) : IllegalStateException(
    if (retryable) "Retry the exact saved causal action." else "The saved causal action needs review. Retain its original contents."
)

/** One attempt only. The owning coordinator must durably save the request
 * first, bind authentication, and commit verified history before retirement. */
object NativeCausalTransport {
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
