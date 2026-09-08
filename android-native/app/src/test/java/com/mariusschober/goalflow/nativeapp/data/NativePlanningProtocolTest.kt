package com.mariusschober.goalflow.nativeapp.data

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class NativePlanningProtocolTest {
    private val account = "11111111-1111-4111-8111-111111111111"
    private val date = "2026-09-08"
    private fun snapshot() = JSONObject().put("schemaVersion", 1).put("accountId", account)
        .put("enforcementEnabled", false).put("policy", DeliberatePlanning.initial(account, date))
    private fun rejected(block: () -> Unit) { assertTrue(runCatching(block).isFailure) }
    @Test fun `day rejects wrong scope and malformed enforcement flag`() {
        NativePlanningProtocol.day(account, date, snapshot())
        rejected { NativePlanningProtocol.day("other", date, snapshot()) }
        rejected { NativePlanningProtocol.day(account, "2026-09-09", snapshot()) }
        rejected { NativePlanningProtocol.day(account, date, snapshot().put("enforcementEnabled", "false")) }
    }
    @Test fun `day rejects unrelated and duplicate snapshot records`() {
        val record = JSONObject().put("user_id", account).put("entity_type", "tasks").put("entity_id", "task")
            .put("server_version", 4).put("version", 1).put("device_id", "device")
            .put("updated_at", "2026-09-08T10:00:00.000Z").put("deleted_at", JSONObject.NULL)
            .put("payload", JSONObject().put("id", "task").put("scheduledFor", date))
        NativePlanningProtocol.day(account, date, snapshot().put("records", JSONArray().put(record)))
        rejected { NativePlanningProtocol.day(account, date, snapshot().put("records", JSONArray().put(record).put(record))) }
        record.getJSONObject("payload").put("scheduledFor", "2026-09-09")
        rejected { NativePlanningProtocol.day(account, date, snapshot().put("records", JSONArray().put(record))) }
    }
    @Test fun `policy rejects repeated operation and altered allowance evidence`() {
        val command = JSONObject().put("schemaVersion", 1).put("accountId", account).put("localDate", date)
            .put("operationId", "22222222-2222-4222-8222-222222222222").put("baselineRevision", JSONObject.NULL)
            .put("proposedOrder", JSONArray()).put("ratings", JSONArray()).put("maximumAcceptedXp", 0)
            .put("capturedAt", "2026-09-08T10:00:00.000Z")
        val reply = DeliberatePlanning.apply(DeliberatePlanning.initial(account, date), command, emptyList(), 100, "classic")
        NativePlanningProtocol.policy(account, date, reply.policy)
        rejected { NativePlanningProtocol.policy(account, date, JSONObject(reply.policy.toString()).put("acceptedReplans", 9)) }
        reply.policy.getJSONArray("history").put(reply.receipt)
        rejected { NativePlanningProtocol.policy(account, date, reply.policy) }
    }
}
