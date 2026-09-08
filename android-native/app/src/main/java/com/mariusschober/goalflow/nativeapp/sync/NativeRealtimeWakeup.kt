package com.mariusschober.goalflow.nativeapp.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.min
import kotlin.random.Random

internal const val NATIVE_FOREGROUND_SYNC_INTERVAL_MILLIS = 30_000L
internal const val NATIVE_REALTIME_HEARTBEAT_INTERVAL_MILLIS = 20_000L
private const val MAX_REALTIME_MESSAGE_CHARS = 64 * 1024

internal sealed interface NativeRealtimeEvent {
    data object Joined : NativeRealtimeEvent
    data object Wakeup : NativeRealtimeEvent
    data object Disconnected : NativeRealtimeEvent
    data object Ignored : NativeRealtimeEvent
    data object Malformed : NativeRealtimeEvent
}

/** Strict Supabase Realtime v1 codec. It has no client-broadcast operation. */
internal object NativeRealtimeProtocol {
    private val uuidPattern = Regex(
        "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
    )

    fun channelTopic(userId: String): String? = userId
        .takeIf { it.matches(uuidPattern) }
        ?.lowercase()
        ?.let { "tsurfing:user:$it" }

    fun wireTopic(userId: String): String? = channelTopic(userId)?.let { "realtime:$it" }

    fun socketUrl(supabaseUrl: String, publishableKey: String): String {
        val base = supabaseUrl.toHttpUrlOrNull()
            ?: throw IllegalArgumentException("A valid Supabase project URL is required for Realtime.")
        require(base.scheme == "https") { "Supabase Realtime requires HTTPS." }
        require(publishableKey.startsWith("sb_publishable_") || publishableKey.startsWith("eyJ")) {
            "Supabase Realtime requires a public project key."
        }
        return base.newBuilder()
            .scheme("wss")
            .encodedPath("/realtime/v1/websocket")
            .query(null)
            .addQueryParameter("apikey", publishableKey)
            .addQueryParameter("vsn", "1.0.0")
            .build()
            .toString()
    }

    fun join(reference: String, userId: String, accessToken: String): String {
        val topic = wireTopic(userId)
            ?: throw IllegalArgumentException("Realtime topics require an immutable account UUID.")
        require(accessToken.isNotBlank()) { "A current access token is required." }
        val config = JSONObject()
            .put("broadcast", JSONObject().put("ack", false).put("self", false))
            .put("presence", JSONObject().put("enabled", false))
            .put("postgres_changes", JSONArray())
            .put("private", true)
        return envelope(
            topic = topic,
            event = "phx_join",
            payload = JSONObject().put("config", config).put("access_token", accessToken),
            reference = reference,
            joinReference = reference
        )
    }

    fun heartbeat(reference: String): String = envelope(
        topic = "phoenix",
        event = "heartbeat",
        payload = JSONObject(),
        reference = reference,
        joinReference = null
    )

    fun accessToken(joinReference: String, reference: String, userId: String, token: String): String {
        val topic = wireTopic(userId)
            ?: throw IllegalArgumentException("Realtime topics require an immutable account UUID.")
        require(token.isNotBlank()) { "A current access token is required." }
        return envelope(
            topic = topic,
            event = "access_token",
            payload = JSONObject().put("access_token", token),
            reference = reference,
            joinReference = joinReference
        )
    }

    fun leave(joinReference: String, reference: String, userId: String): String {
        val topic = wireTopic(userId)
            ?: throw IllegalArgumentException("Realtime topics require an immutable account UUID.")
        return envelope(topic, "phx_leave", JSONObject(), reference, joinReference)
    }

    fun parse(message: String, userId: String, joinReference: String): NativeRealtimeEvent {
        if (message.length > MAX_REALTIME_MESSAGE_CHARS) return NativeRealtimeEvent.Malformed
        val expectedTopic = wireTopic(userId) ?: return NativeRealtimeEvent.Malformed
        val root = runCatching { JSONObject(message) }.getOrNull()
            ?: return NativeRealtimeEvent.Malformed
        val topic = root.optString("topic")
        val event = root.optString("event")
        if (topic != expectedTopic) return NativeRealtimeEvent.Ignored
        return when (event) {
            "phx_reply" -> {
                if (root.optString("ref") != joinReference) NativeRealtimeEvent.Ignored
                else if (root.optJSONObject("payload")?.optString("status") == "ok") NativeRealtimeEvent.Joined
                else NativeRealtimeEvent.Disconnected
            }
            "broadcast" -> {
                val payload = root.optJSONObject("payload") ?: return NativeRealtimeEvent.Malformed
                if (payload.optString("event") == "sync_wakeup"
                    && payload.opt("payload") is JSONObject
                ) NativeRealtimeEvent.Wakeup else NativeRealtimeEvent.Ignored
            }
            "phx_close", "phx_error" -> NativeRealtimeEvent.Disconnected
            else -> NativeRealtimeEvent.Ignored
        }
    }

    private fun envelope(
        topic: String,
        event: String,
        payload: JSONObject,
        reference: String,
        joinReference: String?
    ): String = JSONObject()
        .put("topic", topic)
        .put("event", event)
        .put("payload", payload)
        .put("ref", reference)
        .put("join_ref", joinReference ?: JSONObject.NULL)
        .toString()
}

internal fun nativeRealtimeReconnectDelayMillis(attempt: Int, jitterMillis: Long): Long {
    val exponent = attempt.coerceIn(0, 6)
    val base = min(500L * (1L shl exponent), 30_000L)
    return min(base + jitterMillis.coerceIn(0L, 250L), 30_000L)
}

internal interface NativeRealtimeSocket {
    fun send(message: String): Boolean
    fun close(code: Int, reason: String): Boolean
}

internal interface NativeRealtimeSocketListener {
    fun onOpen(socket: NativeRealtimeSocket)
    fun onMessage(socket: NativeRealtimeSocket, message: String)
    fun onClosed(socket: NativeRealtimeSocket)
    fun onFailure(socket: NativeRealtimeSocket)
}

internal fun interface NativeRealtimeTransport {
    fun connect(url: String, listener: NativeRealtimeSocketListener): NativeRealtimeSocket
}

internal class OkHttpNativeRealtimeTransport : NativeRealtimeTransport {
    override fun connect(url: String, listener: NativeRealtimeSocketListener): NativeRealtimeSocket {
        val delegate = AtomicReference<WebSocket?>()
        val socket = object : NativeRealtimeSocket {
            override fun send(message: String): Boolean = delegate.get()?.send(message) ?: false
            override fun close(code: Int, reason: String): Boolean = delegate.get()?.close(code, reason) ?: false
        }
        val webSocket = nativeOkHttpClient.newWebSocket(
            Request.Builder().url(url).header("Cache-Control", "no-store").build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen(socket)
                override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(socket, text)
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(socket)
                override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                    response?.close()
                    listener.onFailure(socket)
                }
            }
        )
        delegate.set(webSocket)
        return socket
    }
}

/** Foreground-only private channel with heartbeat, token rotation, and bounded reconnect. */
internal class NativeRealtimeWakeupClient(
    private val scope: CoroutineScope,
    private val transport: NativeRealtimeTransport = OkHttpNativeRealtimeTransport(),
    private val endpoint: () -> String = {
        NativeRealtimeProtocol.socketUrl(NativeConfig.supabaseUrl, NativeConfig.supabasePublicKey)
    },
    private val wait: suspend (Long) -> Unit = { delay(it) },
    private val jitterMillis: () -> Long = { Random.nextLong(0L, 251L) }
) {
    private val lock = Any()
    private var active = false
    private var generation = 0
    private var session: NativeSession? = null
    private var wake: () -> Unit = {}
    private var pendingSocket: NativeRealtimeSocket? = null
    private var socket: NativeRealtimeSocket? = null
    private var joined = false
    private var joinReference = ""
    private var reference = 0L
    private var reconnectAttempt = 0
    private var connectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null

    fun startOrRefresh(nextSession: NativeSession, onWake: () -> Unit) {
        val userId = nextSession.userId?.let(NativeRealtimeProtocol::channelTopic)
            ?.removePrefix("tsurfing:user:")
        if (userId == null || nextSession.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            stop()
            return
        }

        var closeSockets: List<NativeRealtimeSocket> = emptyList()
        var cancelJobs: List<Job> = emptyList()
        var tokenUpdate: Pair<NativeRealtimeSocket, String>? = null
        val targetGeneration: Int
        synchronized(lock) {
            val currentUserId = session?.userId?.lowercase()
            if (!active || currentUserId != userId) {
                closeSockets = listOfNotNull(socket, pendingSocket).distinct()
                cancelJobs = listOfNotNull(connectJob, heartbeatJob, reconnectJob)
                generation += 1
                active = true
                pendingSocket = null
                socket = null
                joined = false
                joinReference = ""
                reconnectAttempt = 0
                connectJob = null
                heartbeatJob = null
                reconnectJob = null
            } else if (joined && socket != null && session?.accessToken != nextSession.accessToken) {
                tokenUpdate = socket!! to NativeRealtimeProtocol.accessToken(
                    joinReference,
                    nextReferenceLocked(),
                    userId,
                    nextSession.accessToken
                )
            }
            session = nextSession.copy(userId = userId)
            wake = onWake
            targetGeneration = generation
        }
        cancelJobs.forEach(Job::cancel)
        closeSockets.forEach { it.close(1000, "account changed") }
        tokenUpdate?.let { (target, message) ->
            if (!target.send(message)) handleDisconnected(targetGeneration, target)
        }
        launchConnect(targetGeneration)
    }

    fun stop() {
        val target: NativeRealtimeSocket?
        val targets: List<NativeRealtimeSocket>
        val leaveMessage: String?
        val jobs: List<Job>
        synchronized(lock) {
            if (!active && socket == null) return
            target = socket
            targets = listOfNotNull(socket, pendingSocket).distinct()
            val userId = session?.userId
            leaveMessage = if (joined && target != null && userId != null && joinReference.isNotBlank()) {
                NativeRealtimeProtocol.leave(joinReference, nextReferenceLocked(), userId)
            } else null
            active = false
            generation += 1
            session = null
            pendingSocket = null
            socket = null
            joined = false
            joinReference = ""
            jobs = listOfNotNull(connectJob, heartbeatJob, reconnectJob)
            connectJob = null
            heartbeatJob = null
            reconnectJob = null
        }
        jobs.forEach(Job::cancel)
        if (leaveMessage != null) target?.send(leaveMessage)
        targets.forEach { it.close(1000, "foreground ended") }
    }

    private fun launchConnect(targetGeneration: Int) {
        val job = scope.launch(start = CoroutineStart.LAZY) { connect(targetGeneration) }
        val accepted = synchronized(lock) {
            if (!active || generation != targetGeneration || socket != null || connectJob != null || reconnectJob != null) {
                false
            } else {
                connectJob = job
                true
            }
        }
        if (accepted) job.start() else job.cancel()
    }

    private suspend fun connect(targetGeneration: Int) {
        val currentJob = currentCoroutineContext()[Job]
        try {
            val candidate = transport.connect(endpoint(), object : NativeRealtimeSocketListener {
                override fun onOpen(socket: NativeRealtimeSocket) = handleOpen(targetGeneration, socket)
                override fun onMessage(socket: NativeRealtimeSocket, message: String) =
                    handleMessage(targetGeneration, socket, message)
                override fun onClosed(socket: NativeRealtimeSocket) = handleDisconnected(targetGeneration, socket)
                override fun onFailure(socket: NativeRealtimeSocket) = handleDisconnected(targetGeneration, socket)
            })
            val shouldClose = synchronized(lock) {
                if (!active || generation != targetGeneration) {
                    true
                } else {
                    if (socket !== candidate) pendingSocket = candidate
                    false
                }
            }
            if (shouldClose) candidate.close(1000, "stale connection")
        } catch (_: Exception) {
            scheduleReconnect(targetGeneration)
        } finally {
            synchronized(lock) {
                if (connectJob === currentJob) connectJob = null
            }
        }
    }

    private fun handleOpen(targetGeneration: Int, openedSocket: NativeRealtimeSocket) {
        val joinMessage: String?
        synchronized(lock) {
            val current = session
            if (!active || generation != targetGeneration || current?.userId == null) {
                joinMessage = null
            } else {
                pendingSocket = null
                socket = openedSocket
                joined = false
                joinReference = nextReferenceLocked()
                joinMessage = NativeRealtimeProtocol.join(joinReference, current.userId, current.accessToken)
            }
        }
        if (joinMessage == null) openedSocket.close(1000, "stale connection")
        else if (!openedSocket.send(joinMessage)) handleDisconnected(targetGeneration, openedSocket)
    }

    private fun handleMessage(targetGeneration: Int, source: NativeRealtimeSocket, message: String) {
        val parsed = synchronized(lock) {
            val userId = session?.userId
            if (!active || generation != targetGeneration || socket !== source || userId == null) {
                return
            }
            NativeRealtimeProtocol.parse(message, userId, joinReference)
        }
        when (parsed) {
            NativeRealtimeEvent.Joined -> {
                val callback = synchronized(lock) {
                    if (!active || generation != targetGeneration || socket !== source) return
                    joined = true
                    reconnectAttempt = 0
                    startHeartbeatLocked(targetGeneration, source)
                    wake
                }
                callback()
            }
            NativeRealtimeEvent.Wakeup -> synchronized(lock) {
                if (active && generation == targetGeneration && joined && socket === source) wake else null
            }?.invoke()
            NativeRealtimeEvent.Disconnected, NativeRealtimeEvent.Malformed -> {
                source.close(1008, "realtime protocol closed")
                handleDisconnected(targetGeneration, source)
            }
            NativeRealtimeEvent.Ignored -> Unit
        }
    }

    private fun startHeartbeatLocked(targetGeneration: Int, target: NativeRealtimeSocket) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                wait(NATIVE_REALTIME_HEARTBEAT_INTERVAL_MILLIS)
                val message = synchronized(lock) {
                    if (!active || generation != targetGeneration || !joined || socket !== target) return@launch
                    NativeRealtimeProtocol.heartbeat(nextReferenceLocked())
                }
                if (!target.send(message)) {
                    handleDisconnected(targetGeneration, target)
                    return@launch
                }
            }
        }
    }

    private fun handleDisconnected(targetGeneration: Int, source: NativeRealtimeSocket) {
        val heartbeat: Job?
        val shouldReconnect = synchronized(lock) {
            if (!active || generation != targetGeneration || (socket !== source && pendingSocket !== source)) return
            if (socket === source) socket = null
            if (pendingSocket === source) pendingSocket = null
            joined = false
            heartbeat = heartbeatJob
            heartbeatJob = null
            true
        }
        heartbeat?.cancel()
        if (shouldReconnect) scheduleReconnect(targetGeneration)
    }

    private fun scheduleReconnect(targetGeneration: Int) {
        val delayMillis: Long
        val job: Job
        synchronized(lock) {
            if (!active || generation != targetGeneration || reconnectJob != null) return
            delayMillis = nativeRealtimeReconnectDelayMillis(reconnectAttempt, jitterMillis())
            reconnectAttempt += 1
            job = scope.launch(start = CoroutineStart.LAZY) {
                wait(delayMillis)
                val currentJob = currentCoroutineContext()[Job]
                synchronized(lock) {
                    if (reconnectJob === currentJob) reconnectJob = null
                }
                launchConnect(targetGeneration)
            }
            reconnectJob = job
        }
        job.start()
    }

    private fun nextReferenceLocked(): String {
        reference = if (reference == Long.MAX_VALUE) 1L else reference + 1L
        return reference.toString()
    }
}
