package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

private const val FOCUS_SESSION_SCHEMA_VERSION = 1
private const val MIN_FOCUS_DURATION_SECONDS = 60L
private const val MAX_FOCUS_DURATION_SECONDS = 1_440L * 60L
private val SESSION_ID_PATTERN = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

enum class NativeFocusSessionPhase {
    ACTIVE,
    PAUSED,
    STOPPED,
    COMPLETED
}

/** The action-level focus record shared by Web, Android, and macOS. */
data class NativeFocusSessionRecord(
    val schemaVersion: Int,
    val sessionId: String,
    val taskId: String,
    val phase: NativeFocusSessionPhase,
    val plannedDurationSeconds: Long,
    val startedAt: String,
    val elapsedSeconds: Long,
    val pausedAt: String?,
    val endedAt: String?,
    val updatedAt: String
) {
    init {
        require(schemaVersion == FOCUS_SESSION_SCHEMA_VERSION) { "The focus session schema is unsupported." }
        require(SESSION_ID_PATTERN.matches(sessionId)) { "The focus session identity is invalid." }
        require(taskId.isNotBlank() && taskId.length <= 240) { "The focus session task identity is invalid." }
        require(plannedDurationSeconds in MIN_FOCUS_DURATION_SECONDS..MAX_FOCUS_DURATION_SECONDS) {
            "The focus session duration is invalid."
        }
        require(elapsedSeconds >= 0L) { "The focus session elapsed time is invalid." }
        val started = parseInstant(startedAt)
        val updated = parseInstant(updatedAt)
        require(!started.isAfter(updated)) { "The focus session clock order is invalid." }
        pausedAt?.let {
            val paused = parseInstant(it)
            require(!paused.isBefore(started) && !paused.isAfter(updated)) { "The focus session pause clock is invalid." }
        }
        endedAt?.let {
            val ended = parseInstant(it)
            require(!ended.isBefore(started) && !ended.isAfter(updated)) { "The focus session end clock is invalid." }
        }
        when (phase) {
            NativeFocusSessionPhase.ACTIVE -> require(pausedAt == null && endedAt == null) {
                "An active focus session cannot have a terminal timestamp."
            }
            NativeFocusSessionPhase.PAUSED -> require(pausedAt != null && endedAt == null) {
                "A paused focus session needs a pause timestamp."
            }
            NativeFocusSessionPhase.STOPPED,
            NativeFocusSessionPhase.COMPLETED -> require(endedAt != null) {
                "A terminal focus session needs an end timestamp."
            }
        }
    }

    fun elapsedSeconds(now: Instant = Instant.now()): Long {
        if (phase != NativeFocusSessionPhase.ACTIVE) return elapsedSeconds
        val elapsedSinceStart = (now.toEpochMilli() - parseInstant(startedAt).toEpochMilli()) / 1_000L
        return elapsedSeconds + elapsedSinceStart.coerceAtLeast(0L)
    }

    fun remainingSeconds(now: Instant = Instant.now()): Long =
        (plannedDurationSeconds - elapsedSeconds(now)).coerceAtLeast(0L)

    fun overtimeSeconds(now: Instant = Instant.now()): Long =
        if (phase == NativeFocusSessionPhase.ACTIVE) {
            (elapsedSeconds(now) - plannedDurationSeconds).coerceAtLeast(0L)
        } else 0L

    fun pause(now: Instant = Instant.now()): NativeFocusSessionRecord {
        if (phase != NativeFocusSessionPhase.ACTIVE) return this
        val timestamp = now.toString()
        return copy(
            phase = NativeFocusSessionPhase.PAUSED,
            elapsedSeconds = elapsedSeconds(now),
            pausedAt = timestamp,
            endedAt = null,
            updatedAt = timestamp
        )
    }

    fun resume(now: Instant = Instant.now()): NativeFocusSessionRecord {
        if (phase != NativeFocusSessionPhase.PAUSED) return this
        val timestamp = now.toString()
        return copy(
            phase = NativeFocusSessionPhase.ACTIVE,
            startedAt = timestamp,
            pausedAt = null,
            endedAt = null,
            updatedAt = timestamp
        )
    }

    fun stop(now: Instant = Instant.now()): NativeFocusSessionRecord {
        if (phase == NativeFocusSessionPhase.STOPPED || phase == NativeFocusSessionPhase.COMPLETED) return this
        val timestamp = now.toString()
        return copy(
            phase = NativeFocusSessionPhase.STOPPED,
            elapsedSeconds = elapsedSeconds(now),
            pausedAt = null,
            endedAt = timestamp,
            updatedAt = timestamp
        )
    }

    fun complete(now: Instant = Instant.now()): NativeFocusSessionRecord {
        if (phase == NativeFocusSessionPhase.COMPLETED) return this
        val timestamp = now.toString()
        return copy(
            phase = NativeFocusSessionPhase.COMPLETED,
            elapsedSeconds = elapsedSeconds(now),
            pausedAt = null,
            endedAt = timestamp,
            updatedAt = timestamp
        )
    }

    fun extend(deltaSeconds: Long, now: Instant = Instant.now()): NativeFocusSessionRecord {
        if (deltaSeconds <= 0L) return this
        val duration = (plannedDurationSeconds + deltaSeconds).coerceAtMost(MAX_FOCUS_DURATION_SECONDS)
        return copy(plannedDurationSeconds = duration, updatedAt = now.toString())
    }

    fun toJson(): JSONObject = JSONObject()
        .put("schemaVersion", schemaVersion)
        .put("sessionId", sessionId)
        .put("taskId", taskId)
        .put("phase", phase.wireValue)
        .put("plannedDurationSeconds", plannedDurationSeconds)
        .put("startedAt", startedAt)
        .put("elapsedSeconds", elapsedSeconds)
        .put("pausedAt", pausedAt ?: JSONObject.NULL)
        .put("endedAt", endedAt ?: JSONObject.NULL)
        .put("updatedAt", updatedAt)

    companion object {
        fun start(
            taskId: String,
            plannedDurationSeconds: Long,
            now: Instant = Instant.now(),
            sessionId: String = UUID.randomUUID().toString()
        ): NativeFocusSessionRecord = NativeFocusSessionRecord(
            schemaVersion = FOCUS_SESSION_SCHEMA_VERSION,
            sessionId = sessionId,
            taskId = taskId,
            phase = NativeFocusSessionPhase.ACTIVE,
            plannedDurationSeconds = plannedDurationSeconds,
            startedAt = now.toString(),
            elapsedSeconds = 0L,
            pausedAt = null,
            endedAt = null,
            updatedAt = now.toString()
        )

        fun fromJson(value: JSONObject): NativeFocusSessionRecord {
            val schema = value.opt("schemaVersion")
            require(schema is Number && schema.toLong().toInt().toLong() == schema.toLong()) {
                "The focus session schema is invalid."
            }
            val phase = when (value.optString("phase")) {
                "active" -> NativeFocusSessionPhase.ACTIVE
                "paused" -> NativeFocusSessionPhase.PAUSED
                "stopped" -> NativeFocusSessionPhase.STOPPED
                "completed" -> NativeFocusSessionPhase.COMPLETED
                else -> throw IllegalArgumentException("The focus session phase is invalid.")
            }
            val planned = value.opt("plannedDurationSeconds")
            val elapsed = value.opt("elapsedSeconds")
            require(planned is Number && planned.toLong().toDouble() == planned.toDouble()) {
                "The focus session duration is invalid."
            }
            require(elapsed is Number && elapsed.toLong().toDouble() == elapsed.toDouble()) {
                "The focus session elapsed time is invalid."
            }
            return NativeFocusSessionRecord(
                schemaVersion = schema.toInt(),
                sessionId = value.optString("sessionId"),
                taskId = value.optString("taskId"),
                phase = phase,
                plannedDurationSeconds = planned.toLong(),
                startedAt = value.optString("startedAt"),
                elapsedSeconds = elapsed.toLong(),
                pausedAt = value.optionalInstant("pausedAt"),
                endedAt = value.optionalInstant("endedAt"),
                updatedAt = value.optString("updatedAt")
            )
        }

        fun fromTrackingPayload(payload: String?): NativeFocusSessionRecord? {
            if (payload == null) return null
            val root = JSONObject(payload)
            if (!root.has("focusSession") || root.isNull("focusSession")) return null
            return fromJson(root.getJSONObject("focusSession"))
        }

        private fun JSONObject.optionalInstant(key: String): String? {
            if (!has(key) || isNull(key)) return null
            return optString(key).takeIf(String::isNotBlank)
                ?: throw IllegalArgumentException("The focus session timestamp is invalid.")
        }

        private fun parseInstant(value: String): Instant =
            runCatching { Instant.parse(value) }.getOrElse {
                throw IllegalArgumentException("The focus session timestamp is invalid.")
            }
    }
}

private val NativeFocusSessionPhase.wireValue: String
    get() = name.lowercase()

/** Legacy local timer anchor retained as a recovery mirror during migration. */
data class NativeFocusSession(
    val taskId: String,
    val startedAtMillis: Long
)

/**
 * Keeps the one active focus session recoverable across backgrounding and
 * process death. Shared tracking is authoritative after a pull; this store is
 * only a local recovery mirror and legacy anchor.
 */
class GoalflowFocusSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun read(): NativeFocusSession? {
        val taskId = preferences.getString(KEY_TASK_ID, null)?.trim().orEmpty()
        val startedAt = preferences.getLong(KEY_STARTED_AT, 0L)
        return if (taskId.isNotBlank() && startedAt > 0L) NativeFocusSession(taskId, startedAt) else null
    }

    @Synchronized
    fun readRecord(): NativeFocusSessionRecord? = preferences.getString(KEY_RECORD_JSON, null)
        ?.let { runCatching { NativeFocusSessionRecord.fromJson(JSONObject(it)) }.getOrNull() }

    @Synchronized
    fun saveRecord(record: NativeFocusSessionRecord) {
        val payload = record.toJson().toString()
        check(preferences.edit()
            .putString(KEY_RECORD_JSON, payload)
            .putString(KEY_TASK_ID, record.taskId)
            .putLong(KEY_STARTED_AT, runCatching { Instant.parse(record.startedAt).toEpochMilli() }.getOrDefault(1L).coerceAtLeast(1L))
            .commit()) { "The focus session could not be stored durably." }
        check(readRecord() == record) { "The focus session failed read-back verification." }
    }

    @Synchronized
    fun beginOrResume(taskId: String, now: Long = System.currentTimeMillis()): NativeFocusSession {
        require(taskId.isNotBlank()) { "A focus session needs a commitment." }
        val existing = read()
        if (existing?.taskId == taskId) return existing
        val session = NativeFocusSession(taskId, now.coerceAtLeast(1L))
        check(preferences.edit()
            .putString(KEY_TASK_ID, session.taskId)
            .putLong(KEY_STARTED_AT, session.startedAtMillis)
            .remove(KEY_RECORD_JSON)
            .commit()) { "The focus session could not be stored durably." }
        check(read() == session) { "The focus session failed read-back verification." }
        return session
    }

    @Synchronized
    fun clear() {
        check(preferences.edit().remove(KEY_TASK_ID).remove(KEY_STARTED_AT).remove(KEY_RECORD_JSON).commit()) {
            "The focus session could not be cleared durably."
        }
    }

    private companion object {
        const val STORE_NAME = "goalflow-native-focus"
        const val KEY_TASK_ID = "task_id"
        const val KEY_STARTED_AT = "started_at"
        const val KEY_RECORD_JSON = "record_json"
    }
}
