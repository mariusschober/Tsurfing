package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.mariusschober.goalflow.nativeapp.widget.GoalflowWidgetUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** Owns foreground wake-ups; WorkManager remains the durable background fallback. */
class NativeForegroundSyncCoordinator(
    context: Context,
    private val syncEngine: NativeSyncEngine,
    private val sessionStore: SecureSessionStore,
    private val authClient: NativeAuthClient = NativeAuthClient(sessionStore)
) {
    private val applicationContext = context.applicationContext
    private val connectivity = applicationContext.getSystemService(ConnectivityManager::class.java)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val foreground = AtomicBoolean(false)
    private val requests = Channel<Unit>(Channel.CONFLATED)
    private val realtime = NativeRealtimeWakeupClient(scope)
    private var collectorJob: Job? = null
    private var pollJob: Job? = null
    private var callbackRegistered = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = requestSync()
        override fun onLost(network: Network) {
            if (!isOnline()) realtime.stop()
        }
    }

    fun start() {
        if (!foreground.compareAndSet(false, true)) {
            requestSync()
            return
        }
        registerNetworkCallback()
        collectorJob = scope.launch {
            for (ignored in requests) {
                if (foreground.get() && isOnline()) synchronizeAndSubscribe()
            }
        }
        pollJob = scope.launch {
            while (isActive && foreground.get()) {
                delay(NATIVE_FOREGROUND_SYNC_INTERVAL_MILLIS)
                requestSync()
            }
        }
        requestSync()
    }

    fun stop() {
        if (!foreground.compareAndSet(true, false)) return
        unregisterNetworkCallback()
        collectorJob?.cancel()
        pollJob?.cancel()
        collectorJob = null
        pollJob = null
        while (requests.tryReceive().isSuccess) Unit
        realtime.stop()
    }

    fun requestSync() {
        if (foreground.get()) requests.trySend(Unit)
    }

    fun sessionChanged() {
        if (sessionStore.read() == null) realtime.stop()
        requestSync()
    }

    private suspend fun synchronizeAndSubscribe() {
        val session = try {
            authClient.currentSession()
        } catch (_: Exception) {
            if (sessionStore.read() == null) realtime.stop()
            return
        }
        val userId = session?.userId
        if (session == null || userId == null || NativeRealtimeProtocol.channelTopic(userId) == null) {
            realtime.stop()
            return
        }
        realtime.startOrRefresh(session) { requestSync() }
        try {
            syncEngine.synchronize()
        } catch (_: NativeSyncMfaRequired) {
            // AAL1 is a valid sign-in needed to complete MFA. Keep it and the
            // Room outbox; the elevation event requests synchronization again.
            realtime.stop()
        } catch (_: AuthenticationExpiredDuringSync) {
            runCatching { sessionStore.clear() }
            realtime.stop()
        } catch (_: Exception) {
            // The Room outbox and cursor remain authoritative. A wake, network
            // recovery, local mutation, or the 30-second fallback retries.
        } finally {
            GoalflowWidgetUpdater.refresh(applicationContext)
        }
    }

    private fun isOnline(): Boolean {
        val network = connectivity.activeNetwork ?: return false
        val capabilities = connectivity.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun registerNetworkCallback() {
        if (callbackRegistered) return
        runCatching { connectivity.registerDefaultNetworkCallback(networkCallback) }
            .onSuccess { callbackRegistered = true }
    }

    private fun unregisterNetworkCallback() {
        if (!callbackRegistered) return
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        callbackRegistered = false
    }

    @Suppress("unused")
    fun close() {
        stop()
        scope.cancel()
    }
}
