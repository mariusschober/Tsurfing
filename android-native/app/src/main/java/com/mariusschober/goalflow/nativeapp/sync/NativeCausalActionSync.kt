package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.GoalflowRepository
import com.mariusschober.goalflow.nativeapp.data.NativeCausalProjectionResult

data class NativeCausalActionSyncResult(val projection: NativeCausalProjectionResult,
    val sent: Int, val moreReady: Boolean)

/** One bounded pass through the existing authenticated transport. Every send
 * follows durable capture; every next action follows verified history apply.
 * Interrupted passes resume the same saved requests and original admissions. */
class NativeCausalActionSync(private val repository: GoalflowRepository,
    private val request: suspend (String, String, String?) -> NativeHttpResponse) {
    suspend fun synchronize(accountId: String, maximumActions: Int = 50, drainOrdinary: suspend () -> Unit = {}): NativeCausalActionSyncResult {
        require(maximumActions in 1..50) { "Invalid causal pass limit." }
        val evidence = NativeCausalEvidenceSync(repository.causalEnrollmentStore, repository.causalHistoryStore, request)
        suspend fun apply(): NativeCausalProjectionResult {
            evidence.synchronize(accountId)
            return repository.applyCausalHistory(accountId)
        }
        var projection = apply()
        var sent = 0
        while (sent < maximumActions) {
            drainOrdinary()
            val id = repository.causalRequestStore.nextReady(accountId) ?: break
            val bytes = repository.causalRequestStore.prepare(accountId, id)
            val receipt = NativeCausalTransport.sendBound(accountId, bytes, request)
            repository.causalRequestStore.accept(accountId, id, receipt)
            sent++
            projection = apply()
        }
        return NativeCausalActionSyncResult(projection, sent, repository.causalRequestStore.nextReady(accountId) != null)
    }
}
