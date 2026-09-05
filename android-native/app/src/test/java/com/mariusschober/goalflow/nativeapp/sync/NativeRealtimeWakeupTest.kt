package com.mariusschober.goalflow.nativeapp.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeRealtimeWakeupTest {
    private val userId = "aaaaaaaa-1111-4111-8111-111111111111"

    @Test
    fun `private join is bound to immutable UUID and has no write subscription`() {
        assertEquals("tsurfing:user:$userId", NativeRealtimeProtocol.channelTopic(userId.uppercase()))
        assertNull(NativeRealtimeProtocol.channelTopic("owner@tsurfing.com"))

        val join = JSONObject(NativeRealtimeProtocol.join("1", userId, "synthetic-access-token"))
        assertEquals("realtime:tsurfing:user:$userId", join.getString("topic"))
        assertEquals("phx_join", join.getString("event"))
        val config = join.getJSONObject("payload").getJSONObject("config")
        assertTrue(config.getBoolean("private"))
        assertFalse(config.getJSONObject("broadcast").getBoolean("ack"))
        assertFalse(config.getJSONObject("broadcast").getBoolean("self"))
        assertEquals(0, config.getJSONArray("postgres_changes").length())
    }

    @Test
    fun `codec accepts only an exact topic sync wakeup and ignores its body`() {
        val joined = JSONObject()
            .put("topic", "realtime:tsurfing:user:$userId")
            .put("event", "phx_reply")
            .put("ref", "7")
            .put("join_ref", "7")
            .put("payload", JSONObject().put("status", "ok").put("response", JSONObject()))
        assertEquals(NativeRealtimeEvent.Joined, NativeRealtimeProtocol.parse(joined.toString(), userId, "7"))

        val wake = JSONObject()
            .put("topic", "realtime:tsurfing:user:$userId")
            .put("event", "broadcast")
            .put("payload", JSONObject()
                .put("event", "sync_wakeup")
                .put("type", "broadcast")
                .put("payload", JSONObject().put("id", "opaque")))
        assertEquals(NativeRealtimeEvent.Wakeup, NativeRealtimeProtocol.parse(wake.toString(), userId, "7"))

        wake.put("topic", "realtime:tsurfing:user:bbbbbbbb-1111-4111-8111-111111111111")
        assertEquals(NativeRealtimeEvent.Ignored, NativeRealtimeProtocol.parse(wake.toString(), userId, "7"))
        wake.put("topic", "realtime:tsurfing:user:$userId")
        wake.getJSONObject("payload").put("event", "task_payload")
        assertEquals(NativeRealtimeEvent.Ignored, NativeRealtimeProtocol.parse(wake.toString(), userId, "7"))
    }

    @Test
    fun `adapter catches up on join and wake and rotates token without client broadcast`() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val socket = FakeSocket()
        var listener: NativeRealtimeSocketListener? = null
        val client = NativeRealtimeWakeupClient(
            scope = scope,
            transport = NativeRealtimeTransport { _, installed ->
                listener = installed
                installed.onOpen(socket)
                socket
            },
            endpoint = { "wss://example.invalid/realtime/v1/websocket" }
        )
        var pulls = 0
        val session = NativeSession(
            accessToken = "synthetic-token-one",
            refreshToken = "synthetic-refresh",
            expiresAtMillis = System.currentTimeMillis() + 3_600_000L,
            userId = userId
        )
        client.startOrRefresh(session) { pulls += 1 }

        val join = JSONObject(socket.messages.single())
        val joinRef = join.getString("ref")
        val joinReply = JSONObject()
            .put("topic", join.getString("topic"))
            .put("event", "phx_reply")
            .put("ref", joinRef)
            .put("join_ref", joinRef)
            .put("payload", JSONObject().put("status", "ok").put("response", JSONObject()))
        listener!!.onMessage(socket, joinReply.toString())
        assertEquals(1, pulls)

        val wake = JSONObject()
            .put("topic", join.getString("topic"))
            .put("event", "broadcast")
            .put("payload", JSONObject()
                .put("event", "sync_wakeup")
                .put("payload", JSONObject().put("id", "opaque")))
        listener!!.onMessage(socket, wake.toString())
        assertEquals(2, pulls)

        client.startOrRefresh(session.copy(accessToken = "synthetic-token-two")) { pulls += 1 }
        assertEquals(listOf("phx_join", "access_token"), socket.messages.map { JSONObject(it).getString("event") })
        assertTrue(socket.messages.none { JSONObject(it).getString("event") == "broadcast" })
        client.stop()
        assertTrue(socket.closed)
        assertEquals("phx_leave", JSONObject(socket.messages.last()).getString("event"))
        scope.cancel()
    }

    @Test
    fun `foreground stop closes a socket that has not joined yet`() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val socket = FakeSocket()
        val client = NativeRealtimeWakeupClient(
            scope = scope,
            transport = NativeRealtimeTransport { _, _ -> socket },
            endpoint = { "wss://example.invalid/realtime/v1/websocket" }
        )

        client.startOrRefresh(
            NativeSession(
                accessToken = "synthetic-token",
                refreshToken = "synthetic-refresh",
                expiresAtMillis = System.currentTimeMillis() + 3_600_000L,
                userId = userId
            )
        ) { }
        client.stop()

        assertTrue(socket.closed)
        assertTrue(socket.messages.isEmpty())
        scope.cancel()
    }

    @Test
    fun `reconnect backoff is bounded and foreground fallback is thirty seconds`() {
        assertEquals(500L, nativeRealtimeReconnectDelayMillis(0, 0))
        assertEquals(1_250L, nativeRealtimeReconnectDelayMillis(1, 250))
        assertEquals(30_000L, nativeRealtimeReconnectDelayMillis(20, 250))
        assertEquals(30_000L, NATIVE_FOREGROUND_SYNC_INTERVAL_MILLIS)
        assertTrue(NATIVE_REALTIME_HEARTBEAT_INTERVAL_MILLIS < 25_000L)
    }

    private class FakeSocket : NativeRealtimeSocket {
        val messages = mutableListOf<String>()
        var closed = false
        override fun send(message: String): Boolean = messages.add(message)
        override fun close(code: Int, reason: String): Boolean {
            closed = true
            return true
        }
    }
}
