package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONObject

class NativeCompletionDependencyPending : IllegalStateException("Completion is waiting for its exact predecessor receipt.")

/** Resolve bases before freezing bytes. Rechecking a retained request never
 * changes it: the original dependency proofs must still yield the same bytes. */
object NativeCompletionRequestEvidence {
    private fun same(a: Any?, b: Any?) = ActionJson.canonical(a) == ActionJson.canonical(b)
    private fun meaning(value: JSONObject) = JSONObject(value.toString()).apply { remove("baseServerVersion") }
    private fun queued(value: JSONObject): SyncOutboxEntity {
        fun optional(key: String) = if (value.isNull(key)) null else value.getString(key)
        val row = SyncOutboxEntity(value.getString("mutationId"), value.getString("deviceId"), value.getString("entityType"),
            value.getString("entityId"), if (value.isNull("baseServerVersion")) null else value.getLong("baseServerVersion"),
            value.getLong("version"), value.getString("payload"), value.getString("updatedAt"), optional("deletedAt"),
            optional("dependsOnMutationId"), optional("resolvesConflictId"), optional("attemptedAt"))
        require(same(NativeLegacyReceiptEvidence.queued(row), value)) { "The captured predecessor request cannot be normalized or truncated." }
        return row
    }

    fun resolved(accountId: String, state: JSONObject, id: String): JSONObject {
        val operation = JSONObject(NativeCompletionAdmissionEvidence.operation(state, id).toString())
            .put("changes", NativePlanningCompletionRebase.members(state, id))
        val command = operation.getJSONObject("command")
        val parent = command.opt("expectedRevision") as? String
        if (parent != null && state.getJSONObject("focusAdmissions").has(parent)) {
            val request = state.optJSONObject("causalRequests")?.optString(parent)?.takeIf { it.isNotEmpty() }
                ?: throw NativeCompletionDependencyPending()
            val receipt = state.optJSONObject("causalReceipts")?.optJSONObject(parent) ?: throw NativeCompletionDependencyPending()
            val previous = NativeCausalRequestJournal.operation(accountId, JSONObject(request))
            NativeCausalRequestJournal.receipt(accountId, previous, receipt)
            require(receipt.getBoolean("accepted") && same(previous.opt("command"), state.getJSONObject("focusAdmissions").getJSONObject(parent).getJSONObject("command"))) {
                "Completion focus predecessor requires recovery."
            }
        }
        val dependencies = state.getJSONObject("completionAdmissions").getJSONObject(id).getJSONObject("dependencies")
        val members = operation.getJSONArray("changes")
        for (index in 0 until members.length()) {
            val member = members.getJSONObject(index); val dependency = dependencies.optJSONObject(member.getString("mutationId")) ?: continue
            val captured = dependency.getJSONObject("request")
            val base = when (dependency.getString("kind")) {
                "planning" -> {
                    val proof = state.optJSONObject("planningResolutions")?.optJSONObject(dependency.getString("actionId"))
                    if (proof != null) {
                        require(proof.getJSONObject("command").opt("operationId") == dependency.opt("actionId"))
                        NativePlanningCompletionRebase.record(accountId, proof, captured).getLong("server_version")
                    } else {
                    val receipt = state.optJSONObject("planningReceipts")?.optJSONObject(dependency.getString("actionId")) ?: throw NativeCompletionDependencyPending()
                    NativePlanningProtocol.response(accountId, receipt.getJSONObject("receipt").getJSONObject("command"), receipt)
                    require(receipt.getJSONObject("receipt").getString("code") == "APPLIED")
                    val records = receipt.getJSONArray("records")
                    val record = (0 until records.length()).map(records::getJSONObject).single {
                        it.opt("entity_type") == captured.opt("entityType") && it.opt("entity_id") == captured.opt("entityId")
                    }
                    require(same(NativePlanningProtocol.payload(captured.getString("entityType"), record.getJSONObject("payload")), captured.getJSONObject("payload"))) {
                        "Planning predecessor changed. Review the retained completion."
                    }
                    record.getLong("server_version")
                    }
                }
                "legacy" -> NativeLegacyReceiptEvidence.resolvedBase(accountId, state, NativePlanningCompletionRebase.edit(state, queued(captured))) ?: throw NativeCompletionDependencyPending()
                "completion" -> {
                    val action = dependency.getString("actionId")
                    val bytes = state.optJSONObject("causalRequests")?.optString(action)?.takeIf { it.isNotEmpty() } ?: throw NativeCompletionDependencyPending()
                    val receipt = state.optJSONObject("causalReceipts")?.optJSONObject(action) ?: throw NativeCompletionDependencyPending()
                    val previous = NativeCausalProtocol.completion(accountId, JSONObject(bytes)); NativeCausalProtocol.completionReceipt(accountId, previous, receipt)
                    require(receipt.getBoolean("accepted")) { "A preceding completion requires recovery." }
                    val changes = previous.getJSONArray("changes")
                    val position = (0 until changes.length()).single { changes.getJSONObject(it).opt("mutationId") == captured.opt("mutationId") }
                    val effective = NativePlanningCompletionRebase.members(state, action)
                    val predecessor = (0 until effective.length()).map(effective::getJSONObject).single { it.opt("mutationId") == captured.opt("mutationId") }
                    require(same(meaning(changes.getJSONObject(position)), meaning(predecessor))) { "Completion predecessor request differs." }
                    receipt.getJSONArray("changes").getJSONObject(position).getLong("serverVersion")
                }
                else -> error("Invalid completion dependency kind.")
            }
            member.put("baseServerVersion", base)
        }
        return NativeCausalProtocol.completion(accountId, operation)
    }

    fun assertOperation(accountId: String, state: JSONObject, id: String, operation: JSONObject) {
        require(same(resolved(accountId, state, id), operation)) { "The frozen completion differs from its original admission and dependency receipts." }
    }
}
