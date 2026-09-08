package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.NativeCausalEnrollmentProtocol
import com.mariusschober.goalflow.nativeapp.data.NativeCausalEnrollmentStore
import com.mariusschober.goalflow.nativeapp.data.NativeCausalHistoryProtocol
import com.mariusschober.goalflow.nativeapp.data.NativeCausalHistoryStore
import org.json.JSONObject

data class NativeCausalEvidenceResult(val epoch: String, val downloadedRevision: Long)

/** Uses the existing authenticated/session-bound request callback. Enrollment
 * bytes are committed before HTTP; no history or receipt retires a local action. */
class NativeCausalEvidenceSync(private val enrollment: NativeCausalEnrollmentStore,
    private val history: NativeCausalHistoryStore,
    private val request: suspend (String, String, String?) -> NativeHttpResponse) {
    private suspend fun json(path: String, method: String, body: String?, maximumBytes: Int): JSONObject {
        val response = request(path, method, body)
        if (response.code !in 200..299) throw NativeCausalTransportException(response.code,
            response.code in setOf(408, 425, 429) || response.code >= 500)
        if (response.body.toByteArray(Charsets.UTF_8).size > maximumBytes) throw NativeSyncProtocolException("Causal evidence exceeded the safe response limit.")
        return JSONObject(response.body)
    }
    suspend fun synchronize(accountId: String): NativeCausalEvidenceResult {
        suspend fun discover() = NativeCausalEnrollmentProtocol.capability(accountId,
            json("/api/v1/sync/causal-capability", "GET", null, 16 * 1024))
        var capability = discover()
        val attempt = enrollment.current(accountId) ?: if (!capability.getBoolean("enrolled")) enrollment.prepare(accountId) else null
        if (!capability.getBoolean("enrolled") && attempt == null) throw NativeSyncProtocolException("The preserved tracking baseline needs explicit recovery before enrollment.")
        if (attempt != null && !attempt.hasReceipt && (!capability.getBoolean("enrolled") || capability.opt("epoch") == attempt.epoch)) {
            val upload = ReconciliationUpload.prepareBody(attempt.bytes)
            for (chunk in upload.chunks) {
                val ack = json("/api/v1/sync/conflicts/stage", "POST", chunk.toString(), 16 * 1024)
                ReconciliationUpload.verifyAck(chunk, ack.toString())
            }
            val receipt = json("/api/v1/sync/${attempt.route}${if (upload.manifest == null) "" else "-staged"}", "POST",
                upload.manifest?.toString() ?: attempt.bytes, 16 * 1024 * 1024)
            enrollment.accept(accountId, attempt, receipt)
            capability = discover()
        }
        enrollment.bind(accountId, capability)
        // Resume the original pinned entry before extending a later horizon.
        suspend fun download() {
            while (true) {
                val position = history.next(accountId) ?: break
                val raw = json("/api/v1/sync/causal-history?epoch=${position.epoch}&revision=${position.revision}&throughRevision=${position.throughRevision}&offset=${position.offset}", "GET", null, 72 * 1024)
                history.accept(accountId, position, NativeCausalHistoryProtocol.chunk(accountId, position, raw))
            }
        }
        val epoch = capability.getString("epoch"); val through = capability.getLong("projectionRevision")
        history.resumeOrBegin(accountId, epoch, through)
        download()
        history.begin(accountId, epoch, through)
        download()
        return NativeCausalEvidenceResult(epoch, through)
    }
}
