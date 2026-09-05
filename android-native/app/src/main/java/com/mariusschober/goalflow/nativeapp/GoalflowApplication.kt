package com.mariusschober.goalflow.nativeapp

import android.app.Application
import com.mariusschober.goalflow.nativeapp.data.GoalflowPreferences
import com.mariusschober.goalflow.nativeapp.data.GoalflowDatabase
import com.mariusschober.goalflow.nativeapp.data.GoalflowFocusSessionStore
import com.mariusschober.goalflow.nativeapp.data.GoalflowRepository
import com.mariusschober.goalflow.nativeapp.sync.NativeSyncEngine
import com.mariusschober.goalflow.nativeapp.sync.NativeConfig
import com.mariusschober.goalflow.nativeapp.sync.NativeForegroundSyncCoordinator
import com.mariusschober.goalflow.nativeapp.sync.NativeSyncScheduler
import com.mariusschober.goalflow.nativeapp.sync.SecureSessionStore
import com.mariusschober.goalflow.nativeapp.widget.GoalflowWidgetUpdater
import java.util.UUID

class GoalflowApplication : Application() {
    val database: GoalflowDatabase by lazy { GoalflowDatabase.create(this) }
    private val devicePreferences by lazy { getSharedPreferences("goalflow-native", MODE_PRIVATE) }
    val deviceId: String by lazy {
        devicePreferences.getString("device_id", null) ?: UUID.randomUUID().toString().also { created ->
            check(devicePreferences.edit().putString("device_id", created).commit()) {
                "A stable synchronization device identity could not be persisted."
            }
            check(devicePreferences.getString("device_id", null) == created) {
                "The synchronization device identity failed read-back verification."
            }
        }
    }
    val sessionStore: SecureSessionStore by lazy { SecureSessionStore(this) }
    val preferences: GoalflowPreferences by lazy { GoalflowPreferences(this) }
    val focusSessionStore: GoalflowFocusSessionStore by lazy { GoalflowFocusSessionStore(this) }
    val soundController: GoalflowSoundController by lazy { GoalflowSoundController() }
    val repository: GoalflowRepository by lazy {
        GoalflowRepository(
            database = database,
            deviceId = deviceId,
            onMutation = {
                runCatching { NativeSyncScheduler.schedule(this) }
                runCatching { foregroundSyncCoordinator.requestSync() }
                GoalflowWidgetUpdater.refresh(this)
            },
            syncBindingProvider = {
                com.mariusschober.goalflow.nativeapp.data.GoalflowSyncBinding(
                    backendOrigin = NativeConfig.apiOrigin.ifBlank { "unconfigured" },
                    protocolVersion = 3,
                    accountSubject = sessionStore.read()?.userId
                )
            }
        )
    }
    val syncEngine: NativeSyncEngine by lazy { NativeSyncEngine(repository, sessionStore) }
    val foregroundSyncCoordinator: NativeForegroundSyncCoordinator by lazy {
        NativeForegroundSyncCoordinator(this, syncEngine, sessionStore)
    }

    override fun onCreate() {
        super.onCreate()
        // Cloud work is scheduled after the first usable UI frame. Room-backed
        // local state must own startup and never wait behind WorkManager.
    }
}
