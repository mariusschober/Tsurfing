package com.mariusschober.goalflow.nativeapp.data

import com.mariusschober.goalflow.nativeapp.domain.DailyPlan
import com.mariusschober.goalflow.nativeapp.domain.GoalflowGoal
import com.mariusschober.goalflow.nativeapp.domain.GoalflowHabit
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

data class GoalflowBackupPayload(
    val tasks: List<GoalflowTask>,
    val goals: List<GoalflowGoal>,
    val plans: List<DailyPlan>,
    val habits: List<GoalflowHabit> = emptyList(),
    val events: List<TaskEventEntity> = emptyList(),
    val outbox: List<SyncOutboxEntity> = emptyList(),
    val syncMeta: List<SyncMetaEntity> = emptyList(),
    val conflicts: List<SyncConflictEntity> = emptyList(),
    /** Raw JSON for web collections without a dedicated native model yet. */
    val rawCollections: Map<String, String> = emptyMap(),
    /** Durable, server-verified account identity used to reject cross-account restores. */
    val ownerUserId: String? = null,
    /** Prevents a restore from mixing records from another backend/account. */
    val syncBinding: GoalflowSyncBinding? = null
)

data class GoalflowSyncBinding(
    val backendOrigin: String,
    val protocolVersion: Int,
    val accountSubject: String?
)

data class GoalflowBackupDocument(
    val payload: GoalflowBackupPayload,
    val schemaVersion: Int,
    val exportedAt: String?
)

data class NativeBackupPreview(
    val schemaVersion: Int,
    val exportedAt: String?,
    val incomingTaskCount: Int,
    val incomingGoalCount: Int,
    val incomingHabitCount: Int,
    val incomingPlanCount: Int,
    val incomingEventCount: Int,
    val incomingRawCollectionCount: Int,
    val tasksToAdd: Int,
    val tasksToChange: Int,
    val tasksToRemoveOnReplace: Int,
    val goalsToAdd: Int,
    val goalsToChange: Int,
    val goalsToRemoveOnReplace: Int,
    val habitsToAdd: Int,
    val habitsToChange: Int,
    val habitsToRemoveOnReplace: Int,
    val syncStateCompatible: Boolean,
    val syncStateWillBeQuarantined: Boolean
)

class BackupFormatException(message: String) : IllegalArgumentException(message)

enum class BackupRestoreMode { MERGE, REPLACE }

/** AES-256-GCM + PBKDF2-SHA256 envelope matching the web backup contract. */
object GoalflowBackup {
    private const val FORMAT = "goalflow-encrypted-backup"
    private const val FORMAT_VERSION = 1
    private const val SCHEMA_VERSION = 4
    private const val ITERATIONS = 310_000
    private const val MIN_ITERATIONS = 100_000
    private const val MAX_ITERATIONS = 1_000_000
    private const val MAX_CIPHERTEXT_BYTES = 10 * 1024 * 1024
    private const val RAW_JSON_VALUE_KEY = "__goalflowNativeRawJsonV1"

    fun encrypt(
        payload: GoalflowBackupPayload,
        password: String,
        exportedAt: String = Instant.now().toString()
    ): String {
        requirePassword(password)
        val salt = ByteArray(16).also(SecureRandom()::nextBytes)
        val iv = ByteArray(12).also(SecureRandom()::nextBytes)
        val plaintext = backupJson(payload, exportedAt).toString().toByteArray(StandardCharsets.UTF_8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, deriveKey(password, salt, ITERATIONS), GCMParameterSpec(128, iv))
        val ciphertext = cipher.doFinal(plaintext)
        return JSONObject().apply {
            put("format", FORMAT)
            put("formatVersion", FORMAT_VERSION)
            put("cipher", "AES-256-GCM")
            put("kdf", "PBKDF2-SHA256")
            put("iterations", ITERATIONS)
            put("salt", Base64.getEncoder().encodeToString(salt))
            put("iv", Base64.getEncoder().encodeToString(iv))
            put("ciphertext", Base64.getEncoder().encodeToString(ciphertext))
        }.toString()
    }

    fun decrypt(envelopeText: String, password: String): GoalflowBackupPayload =
        decryptDocument(envelopeText, password).payload

    fun decryptDocument(envelopeText: String, password: String): GoalflowBackupDocument {
        requirePassword(password)
        try {
            val envelope = JSONObject(envelopeText)
            if (envelope.optString("format") != FORMAT || envelope.optInt("formatVersion") != FORMAT_VERSION) {
                throw BackupFormatException("Unsupported encrypted backup format.")
            }
            if (envelope.optString("cipher") != "AES-256-GCM" || envelope.optString("kdf") != "PBKDF2-SHA256") {
                throw BackupFormatException("Unsupported encrypted backup algorithms.")
            }
            val iterations = envelope.optInt("iterations")
            if (iterations !in MIN_ITERATIONS..MAX_ITERATIONS) throw BackupFormatException("Backup KDF parameters are invalid.")
            val salt = decodeBase64(envelope.optString("salt"), 16, "salt")
            val iv = decodeBase64(envelope.optString("iv"), 12, "iv")
            val ciphertext = decodeBase64(envelope.optString("ciphertext"), null, "ciphertext")
            if (ciphertext.size < 16 || ciphertext.size > MAX_CIPHERTEXT_BYTES) throw BackupFormatException("Backup ciphertext is invalid.")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, deriveKey(password, salt, iterations), GCMParameterSpec(128, iv))
            val envelopePayload = JSONObject(String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8))
            val schemaVersion = envelopePayload.optInt("schemaVersion", 1)
            if (schemaVersion !in 1..SCHEMA_VERSION) throw BackupFormatException("This backup was created by a newer Tsurfing version.")
            if (schemaVersion >= 3) {
                runCatching { Instant.parse(envelopePayload.getString("exportedAt")) }
                    .getOrElse { throw BackupFormatException("Backup export timestamp is invalid or missing.") }
            }
            val collections = envelopePayload.optJSONObject("collections") ?: envelopePayload
            val ownerValue = if (schemaVersion >= 4 && envelopePayload.has("ownerKey")) {
                envelopePayload.opt("ownerKey")
            } else if (schemaVersion >= 4 && collections.has("ownerUserId")) {
                collections.opt("ownerUserId")
            } else null
            val ownerUserId = when (ownerValue) {
                null, JSONObject.NULL -> null
                is String -> ownerValue.trim().also { owner ->
                    if (runCatching { java.util.UUID.fromString(owner) }.isFailure) {
                        throw BackupFormatException("Backup account binding is invalid.")
                    }
                }
                else -> throw BackupFormatException("Backup account binding is invalid.")
            }
            val syncBinding = envelopePayload.optJSONObject("syncBinding")?.let(::parseSyncBinding)
            val bindingOwnerUserId = syncBinding?.accountSubject?.trim()?.takeIf(String::isNotBlank)?.let { accountSubject ->
                runCatching { java.util.UUID.fromString(accountSubject).toString() }.getOrNull()
            }
            if (ownerUserId != null && bindingOwnerUserId != null && ownerUserId != bindingOwnerUserId) {
                throw BackupFormatException("Backup account bindings disagree.")
            }
            val payload = parsePayload(collections, ownerUserId, syncBinding)
            val expectedChecksum = envelopePayload.optString("checksum", collections.optString("checksum"))
            if (schemaVersion >= 3 && !expectedChecksum.matches(Regex("^[0-9a-fA-F]{64}$"))) {
                throw BackupFormatException("Backup checksum is invalid or missing.")
            }
            val rawChecksum = sha256(collections.toString())
            val canonicalChecksum = sha256(checksumSource(payload, schemaVersion).toString())
            val webChecksum = sha256(webChecksumSource(collections).toString())
            if (expectedChecksum.isNotBlank()
                && expectedChecksum != rawChecksum
                && expectedChecksum != canonicalChecksum
                && expectedChecksum != webChecksum
            ) {
                throw BackupFormatException("Backup checksum validation failed.")
            }
            return GoalflowBackupDocument(
                payload = payload,
                schemaVersion = schemaVersion,
                exportedAt = envelopePayload.optString("exportedAt").takeIf(String::isNotBlank)
            )
        } catch (error: BackupFormatException) {
            throw error
        } catch (_: Exception) {
            throw BackupFormatException("The backup password is incorrect or the file is damaged.")
        }
    }

    private fun parsePayload(
        collections: JSONObject,
        ownerUserId: String? = null,
        syncBinding: GoalflowSyncBinding? = null
    ): GoalflowBackupPayload {
        // The web backup stores only non-empty collections and calls daily
        // planning decisions `daily_plans`; native backups use explicit empty
        // arrays and the shorter `plans` name. Accept both without weakening
        // validation of records that are present.
        val tasks = optionalArray(collections, "tasks").toString().let { GoalflowJson.parseTasks(it, strict = true) }
        val goals = optionalArray(collections, "goals").toString().let { GoalflowJson.parseGoals(it, strict = true) }
        val plans = parsePlans(optionalArray(collections, "plans", "daily_plans"))
        val events = optionalArray(collections, "events", "task_events").toString()
            .let { GoalflowTaskEventJson.parseEvents(it, strict = true) }
        val habits = optionalArrayOrNull(collections, "habits")?.let { array ->
            buildList(array.length()) {
                for (index in 0 until array.length()) {
                    val item = array.optJSONObject(index) ?: throw BackupFormatException("Backup contains an invalid habit.")
                    add(GoalflowJson.parseHabit(item.toString(), strict = true))
                }
            }
        }.orEmpty()
        val rawCollections = linkedMapOf<String, String>()
        val preserved = collections.opt("rawCollections")
        if (preserved != null && preserved !== JSONObject.NULL && preserved !is JSONObject) {
            throw BackupFormatException("Backup preserved collections are invalid.")
        }
        (preserved as? JSONObject)?.let { raw ->
            val keys = raw.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                addRawCollection(rawCollections, key, rawCollectionText(raw.get(key)))
            }
        }
        val metadataKeys = setOf(
            "tasks", "goals", "plans", "daily_plans", "events", "task_events", "habits", "outbox", "syncMeta", "conflicts",
            "rawCollections", "schemaVersion", "exportedAt", "checksum", "ownerUserId", "syncBinding"
        )
        val directKeys = collections.keys()
        while (directKeys.hasNext()) {
            val key = directKeys.next()
            if (key !in metadataKeys) addRawCollection(rawCollections, key, jsonText(collections.get(key)))
        }
        rawCollections["sync"]?.let(::validatePreservedWebSyncState)
        val payload = GoalflowBackupPayload(
            tasks = tasks,
            goals = goals,
            plans = plans,
            habits = habits,
            events = events,
            outbox = optionalArrayOrNull(collections, "outbox")?.let(::parseOutbox).orEmpty(),
            syncMeta = optionalArrayOrNull(collections, "syncMeta")?.let(::parseSyncMeta).orEmpty(),
            conflicts = optionalArrayOrNull(collections, "conflicts")?.let(::parseConflicts).orEmpty(),
            rawCollections = rawCollections,
            ownerUserId = ownerUserId,
            syncBinding = syncBinding
        )
        requireUnique(payload.tasks.map { it.id }, "task")
        requireUnique(
            payload.tasks
                .filter { it.habitId != null && it.deletedAt == null }
                .map { "${it.habitId}|${it.scheduledFor}" },
            "active habit day"
        )
        requireUnique(payload.goals.map { it.id }, "goal")
        requireUnique(payload.habits.map { it.id }, "habit")
        requireUnique(payload.plans.map { it.localDate }, "planning decision")
        requireUnique(payload.events.map { it.id }, "task event")
        requireUnique(payload.outbox.map { it.mutationId }, "pending mutation")
        requireUnique(payload.syncMeta.map { it.entityType }, "synchronization metadata")
        requireUnique(payload.conflicts.map { it.id }, "conflict")
        validateSyncState(payload)
        return payload
    }

    private fun validatePreservedWebSyncState(raw: String) {
        val value = parseJsonValue(raw) as? JSONObject
            ?: throw BackupFormatException("Preserved web synchronization state is invalid.")
        for (key in listOf("outbox", "conflicts")) {
            if (!value.has(key)) continue
            val rows = value.optJSONArray(key)
                ?: throw BackupFormatException("Preserved web synchronization recovery data is invalid.")
            if (rows.length() > 0) {
                throw BackupFormatException(
                    "This web backup contains pending synchronization recovery data. Restore it in the web app."
                )
            }
        }
    }

    private fun optionalArray(collections: JSONObject, vararg keys: String): JSONArray {
        val present = keys.firstOrNull(collections::has)
        if (present == null) return JSONArray()
        val value = collections.optJSONArray(present)
            ?: throw BackupFormatException("Backup collection $present is invalid.")
        return value
    }

    private fun optionalArrayOrNull(collections: JSONObject, key: String): JSONArray? {
        if (!collections.has(key) || collections.isNull(key)) return null
        return collections.optJSONArray(key)
            ?: throw BackupFormatException("Backup collection $key is invalid.")
    }

    private fun addRawCollection(target: MutableMap<String, String>, key: String, value: String) {
        if (key.isBlank() || key.length > 128 || key.any { it.isISOControl() }) {
            throw BackupFormatException("Backup contains an invalid preserved collection name.")
        }
        val existing = target[key]
        if (existing != null && !jsonEquivalent(existing, value)) {
            throw BackupFormatException("Backup preserves conflicting data for collection $key.")
        }
        target[key] = existing ?: value
    }

    private fun requireUnique(ids: List<String>, kind: String) {
        if (ids.any(String::isBlank) || ids.toSet().size != ids.size) {
            throw BackupFormatException("Backup contains duplicate or invalid $kind identities.")
        }
    }

    private fun backupJson(payload: GoalflowBackupPayload, exportedAt: String): JSONObject = JSONObject().apply {
        put("schemaVersion", SCHEMA_VERSION)
        requireInstant(exportedAt, "backup export timestamp")
        put("exportedAt", exportedAt)
        put("ownerKey", payload.ownerUserId ?: JSONObject.NULL)
        put("checksum", sha256(checksumSource(payload).toString()))
        put("collections", checksumSource(payload))
        payload.syncBinding?.let { put("syncBinding", syncBindingPayload(it)) }
    }

    private fun syncBindingPayload(binding: GoalflowSyncBinding): JSONObject = JSONObject().apply {
        if (binding.backendOrigin.isBlank() || binding.protocolVersion <= 0) {
            throw BackupFormatException("Backup synchronization binding is invalid.")
        }
        put("backendOrigin", binding.backendOrigin)
        put("protocolVersion", binding.protocolVersion)
        put("accountSubject", binding.accountSubject ?: JSONObject.NULL)
    }

    private fun parseSyncBinding(value: JSONObject): GoalflowSyncBinding {
        val backendOrigin = value.optString("backendOrigin").trim()
        val protocolVersion = value.optInt("protocolVersion", 0)
        val accountSubject = value.nullableString("accountSubject")
        if (backendOrigin.isBlank() || protocolVersion <= 0) {
            throw BackupFormatException("Backup synchronization binding is invalid.")
        }
        return GoalflowSyncBinding(backendOrigin, protocolVersion, accountSubject)
    }

    private fun checksumSource(payload: GoalflowBackupPayload, schemaVersion: Int = SCHEMA_VERSION): JSONObject = JSONObject().apply {
        put("tasks", GoalflowJson.tasksPayload(payload.tasks))
        put("goals", GoalflowJson.goalsPayload(payload.goals))
        put("plans", plansPayload(payload.plans))
        if (schemaVersion >= 4) put("events", GoalflowTaskEventJson.eventsPayload(payload.events))
        if (schemaVersion >= 3) {
            put("habits", GoalflowJson.habitsPayload(payload.habits))
            put("outbox", outboxPayload(payload.outbox))
            put("syncMeta", syncMetaPayload(payload.syncMeta))
            put("conflicts", conflictsPayload(payload.conflicts))
        }
        // Schema 2 backups did not contain the native raw-collection wrapper.
        // Keep their checksum source byte-for-byte compatible with that format.
        if (schemaVersion >= 3) put("rawCollections", rawCollectionsPayload(payload.rawCollections))
    }

    private fun rawCollectionsPayload(collections: Map<String, String>): JSONObject = JSONObject().apply {
        collections.toSortedMap().forEach { (key, payload) ->
            // Keep the original JSON text, including object-key order. The
            // native JSON parser is not a lossless transport for web-owned
            // collections, and these values must survive a native restore.
            parseJsonValue(payload)
            put(key, JSONObject().put(RAW_JSON_VALUE_KEY, payload))
        }
    }

    private fun rawCollectionText(value: Any): String {
        if (value is JSONObject && value.has(RAW_JSON_VALUE_KEY)) {
            if (value.length() != 1) throw BackupFormatException("Backup preserved collection wrapper is invalid.")
            val payload = value.opt(RAW_JSON_VALUE_KEY)
            if (payload !is String) throw BackupFormatException("Backup preserved collection wrapper is invalid.")
            parseJsonValue(payload)
            return payload
        }
        return jsonText(value)
    }

    /**
     * The browser exporter writes its typed stores in a stable public order
     * and hashes that object directly. Recreate that order so an encrypted web
     * export can be restored even when the platform JSON implementation does
     * not retain parser key order.
     */
    private fun webChecksumSource(collections: JSONObject): JSONObject = JSONObject().apply {
        val webOrder = listOf(
            "tasks", "goals", "habits", "stats", "progress", "hashtags", "accountability",
            "truenorth", "amalgam", "tracking", "circadian", "settings", "daily_plans", "sync"
        )
        webOrder.filter(collections::has).forEach { key -> put(key, collections.get(key)) }
        collections.keys().asSequence()
            .filter { it !in webOrder }
            .sorted()
            .forEach { key -> put(key, collections.get(key)) }
    }

    private fun plansPayload(plans: List<DailyPlan>): JSONArray = JSONArray().apply {
        plans.forEach { plan ->
            put(JSONObject().apply {
                put("localDate", plan.localDate)
                put("confirmedAt", plan.confirmedAt)
                put("taskIds", JSONArray(plan.taskIds))
            })
        }
    }

    private fun parsePlans(array: JSONArray): List<DailyPlan> = buildList(array.length()) {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: throw BackupFormatException("Backup contains an invalid planning decision.")
            val localDate = item.optString("localDate").trim()
            if (!localDate.matches(Regex("^\\d{4}-\\d{2}-\\d{2}$"))
                || runCatching { java.time.LocalDate.parse(localDate) }.isFailure
                || item.optLong("confirmedAt", 0L) <= 0L
            ) throw BackupFormatException("Backup contains an invalid planning decision.")
            val ids: List<String> = item.optJSONArray("taskIds")?.let { idsArray ->
                buildList {
                    val seen = hashSetOf<String>()
                    for (idIndex in 0 until idsArray.length()) {
                        val id = idsArray.optString(idIndex).trim()
                        if (id.isBlank() || !seen.add(id)) throw BackupFormatException("Backup contains duplicate or invalid planning decision task ids.")
                        add(id)
                    }
                }
            } ?: throw BackupFormatException("Backup contains an invalid planning decision.")
            add(DailyPlan(localDate, item.optLong("confirmedAt", 0L), ids))
        }
    }

    private fun outboxPayload(rows: List<SyncOutboxEntity>): JSONArray = JSONArray().apply {
        rows.forEach { row -> put(JSONObject().apply {
            put("mutationId", row.mutationId); put("deviceId", row.deviceId)
            put("entityType", row.entityType); put("entityId", row.entityId)
            put("baseServerVersion", row.baseServerVersion ?: JSONObject.NULL); put("version", row.version)
            put("payload", row.payload); put("updatedAt", row.updatedAt)
            put("deletedAt", row.deletedAt ?: JSONObject.NULL)
            put("dependsOnMutationId", row.dependsOnMutationId ?: JSONObject.NULL)
            put("resolvesConflictId", row.resolvesConflictId ?: JSONObject.NULL)
            put("attemptedAt", row.attemptedAt ?: JSONObject.NULL)
        }) }
    }

    private fun syncMetaPayload(rows: List<SyncMetaEntity>): JSONArray = JSONArray().apply {
        rows.forEach { row -> put(JSONObject().apply {
            put("entityType", row.entityType); put("cursor", row.cursor); put("localVersion", row.localVersion)
            put("serverVersion", row.serverVersion ?: JSONObject.NULL)
            put("lastSuccessfulSync", row.lastSuccessfulSync ?: JSONObject.NULL)
        }) }
    }

    private fun conflictsPayload(rows: List<SyncConflictEntity>): JSONArray = JSONArray().apply {
        rows.forEach { row -> put(JSONObject().apply {
            put("id", row.id); put("entityType", row.entityType); put("entityId", row.entityId)
            put("mutationId", row.mutationId ?: JSONObject.NULL); put("localPayload", row.localPayload)
            put("localDeletedAt", row.localDeletedAt ?: JSONObject.NULL); put("localHistory", row.localHistory)
            put("serverPayload", row.serverPayload); put("serverDeletedAt", row.serverDeletedAt ?: JSONObject.NULL)
            put("serverVersion", row.serverVersion); put("createdAt", row.createdAt); put("status", row.status)
        }) }
    }

    private fun parseOutbox(array: JSONArray): List<SyncOutboxEntity> = buildList(array.length()) {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: throw BackupFormatException("Backup contains an invalid pending mutation.")
            val mutationId = item.requiredString("mutationId", "pending mutation")
            runCatching { java.util.UUID.fromString(mutationId) }
                .getOrElse { throw BackupFormatException("Backup contains an invalid pending mutation identity.") }
            val payload = item.requiredString("payload", "pending mutation")
            runCatching { parseJsonValue(payload) }
                .getOrElse { throw BackupFormatException("Backup contains an invalid pending mutation payload.") }
            val updatedAt = item.requiredString("updatedAt", "pending mutation")
            requireInstant(updatedAt, "pending mutation timestamp")
            val deletedAt = item.nullableString("deletedAt")
            deletedAt?.let { requireInstant(it, "pending mutation deletion timestamp") }
            val attemptedAt = item.nullableString("attemptedAt")
            attemptedAt?.let { requireInstant(it, "pending mutation attempt timestamp") }
            add(SyncOutboxEntity(
                mutationId = mutationId,
                deviceId = item.requiredString("deviceId", "pending mutation"),
                entityType = item.requiredString("entityType", "pending mutation"),
                entityId = item.requiredString("entityId", "pending mutation"),
                baseServerVersion = item.nullableLong("baseServerVersion"),
                version = item.optLong("version").takeIf { it > 0L } ?: throw BackupFormatException("Backup contains an invalid pending mutation."),
                payload = payload,
                updatedAt = updatedAt,
                deletedAt = deletedAt,
                dependsOnMutationId = item.nullableString("dependsOnMutationId"),
                resolvesConflictId = item.nullableString("resolvesConflictId"),
                attemptedAt = attemptedAt
            ))
        }
    }

    private fun parseSyncMeta(array: JSONArray): List<SyncMetaEntity> = buildList(array.length()) {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: throw BackupFormatException("Backup contains invalid synchronization metadata.")
            val cursor = item.optLong("cursor", -1L)
            val localVersion = item.optLong("localVersion", -1L)
            if (cursor < 0L || localVersion < 0L) throw BackupFormatException("Backup contains invalid synchronization metadata.")
            val serverVersion = if (!item.has("serverVersion") || item.isNull("serverVersion")) null else {
                val raw = item.opt("serverVersion")
                if (raw !is Number || raw.toLong() < 0L) {
                    throw BackupFormatException("Backup contains invalid synchronization metadata.")
                }
                raw.toLong()
            }
            val lastSuccessfulSync = item.nullableString("lastSuccessfulSync")
            lastSuccessfulSync?.let { requireInstant(it, "synchronization timestamp") }
            add(SyncMetaEntity(
                entityType = item.requiredString("entityType", "synchronization metadata"),
                cursor = cursor,
                localVersion = localVersion,
                serverVersion = serverVersion,
                lastSuccessfulSync = lastSuccessfulSync
            ))
        }
    }

    private fun parseConflicts(array: JSONArray): List<SyncConflictEntity> = buildList(array.length()) {
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: throw BackupFormatException("Backup contains an invalid conflict.")
            val localHistory = item.optString("localHistory", "[]")
            val history = runCatching { JSONArray(localHistory) }
                .getOrElse { throw BackupFormatException("Backup contains invalid conflict history.") }
            for (historyIndex in 0 until history.length()) {
                val entry = history.optJSONObject(historyIndex)
                    ?: throw BackupFormatException("Backup contains invalid conflict history.")
                val historyMutationId = entry.requiredString("mutationId", "conflict history")
                runCatching { java.util.UUID.fromString(historyMutationId) }
                    .getOrElse { throw BackupFormatException("Backup contains invalid conflict history identity.") }
                if (!entry.has("payload") || entry.optLong("version", 0L) <= 0L) {
                    throw BackupFormatException("Backup contains invalid conflict history.")
                }
                requireInstant(entry.requiredString("updatedAt", "conflict history"), "conflict history timestamp")
                entry.nullableString("deletedAt")?.let { requireInstant(it, "conflict history deletion timestamp") }
            }
            val serverVersionValue = item.opt("serverVersion")
            if (serverVersionValue !is Number || serverVersionValue.toLong() < 0L) {
                throw BackupFormatException("Backup contains an invalid conflict server version.")
            }
            val createdAt = item.requiredString("createdAt", "conflict")
            requireInstant(createdAt, "conflict timestamp")
            val status = item.optString("status", "unresolved").ifBlank { "unresolved" }
            if (status !in setOf("unresolved", "resolving_local", "replay_mismatch", "unsupported_remote")) {
                throw BackupFormatException("Backup contains an invalid conflict status.")
            }
            val mutationId = item.nullableString("mutationId")
            mutationId?.let {
                runCatching { java.util.UUID.fromString(it) }
                    .getOrElse { throw BackupFormatException("Backup contains an invalid conflict mutation identity.") }
            }
            val localDeletedAt = item.nullableString("localDeletedAt")
            val serverDeletedAt = item.nullableString("serverDeletedAt")
            localDeletedAt?.let { requireInstant(it, "conflict local deletion timestamp") }
            serverDeletedAt?.let { requireInstant(it, "conflict server deletion timestamp") }
            add(SyncConflictEntity(
                id = item.requiredString("id", "conflict"),
                entityType = item.requiredString("entityType", "conflict"),
                entityId = item.optString("entityId", "singleton").ifBlank { "singleton" },
                mutationId = mutationId,
                localPayload = item.optString("localPayload"),
                localDeletedAt = localDeletedAt,
                localHistory = localHistory,
                serverPayload = item.optString("serverPayload"),
                serverDeletedAt = serverDeletedAt,
                serverVersion = serverVersionValue.toLong(),
                createdAt = createdAt,
                status = status
            ))
        }
    }

    private fun JSONObject.requiredString(key: String, kind: String): String = optString(key).trim()
        .takeIf(String::isNotBlank) ?: throw BackupFormatException("Backup contains invalid $kind data.")

    private fun JSONObject.nullableString(key: String): String? =
        if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)

    private fun JSONObject.nullableLong(key: String): Long? {
        if (!has(key) || isNull(key)) return null
        val raw = opt(key)
        if (raw !is Number || raw.toLong() < 0L) {
            throw BackupFormatException("Backup contains an invalid numeric synchronization value.")
        }
        return raw.toLong()
    }

    private fun requireInstant(value: String, kind: String) {
        runCatching { Instant.parse(value) }
            .getOrElse { throw BackupFormatException("Backup contains an invalid $kind.") }
    }

    private fun jsonText(value: Any?): String {
        if (value == null || value === JSONObject.NULL) return "null"
        return when (value) {
            is JSONObject, is JSONArray -> value.toString()
            is String -> JSONObject.quote(value)
            is Number, is Boolean -> value.toString()
            else -> throw BackupFormatException("Backup contains an unsupported collection value.")
        }
    }

    private fun parseJsonValue(value: String): Any = runCatching<Any> { JSONObject(value) }
        .recoverCatching { JSONArray(value) }
        .recoverCatching { JSONArray("[$value]").get(0) }
        .getOrElse { throw BackupFormatException("Backup contains invalid preserved collection data.") }

    private fun jsonEquivalent(left: String, right: String): Boolean = runCatching {
        canonicalJson(parseJsonValue(left)) == canonicalJson(parseJsonValue(right))
    }.getOrDefault(false)

    private fun canonicalJson(value: Any?): String = when {
        value == null || value === JSONObject.NULL -> "null"
        value is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(
            prefix = "{", postfix = "}"
        ) { key -> "${JSONObject.quote(key)}:${canonicalJson(value.opt(key))}" }
        value is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") {
            canonicalJson(value.opt(it))
        }
        value is String -> JSONObject.quote(value)
        value is Number || value is Boolean -> value.toString()
        else -> JSONObject.quote(value.toString())
    }

    private fun validateSyncState(payload: GoalflowBackupPayload) {
        val outboxIds = payload.outbox.mapTo(linkedSetOf()) { it.mutationId }
        val dependencies = payload.outbox.associate { it.mutationId to it.dependsOnMutationId }
        payload.outbox.forEach { mutation ->
            mutation.dependsOnMutationId?.let { dependency ->
                runCatching { java.util.UUID.fromString(dependency) }
                    .getOrElse { throw BackupFormatException("Backup contains an invalid pending dependency identity.") }
                if (dependency !in outboxIds) {
                    throw BackupFormatException("Backup contains a pending mutation with a missing dependency.")
                }
            }
            mutation.resolvesConflictId?.let { conflictId ->
                if (payload.conflicts.none { it.id == conflictId }) {
                    throw BackupFormatException("Backup contains a conflict resolution without its preserved conflict.")
                }
            }
        }
        val unresolved = outboxIds.toMutableSet()
        while (unresolved.isNotEmpty()) {
            val ready = unresolved.filter { mutationId ->
                dependencies[mutationId].isNullOrBlank() || dependencies[mutationId] !in unresolved
            }
            if (ready.isEmpty()) {
                throw BackupFormatException("Backup contains a cyclic pending mutation dependency.")
            }
            unresolved.removeAll(ready.toSet())
        }
        val represented = outboxIds.toMutableSet()
        payload.conflicts.forEach { conflict ->
            val history = JSONArray(conflict.localHistory)
            for (index in 0 until history.length()) {
                val mutationId = history.getJSONObject(index).getString("mutationId")
                if (!represented.add(mutationId)) {
                    throw BackupFormatException("Backup repeats one pending mutation identity in synchronization state.")
                }
            }
        }
    }

    private fun deriveKey(password: String, salt: ByteArray, iterations: Int): SecretKeySpec {
        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, 256)
        return try {
            SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, "AES")
        } finally {
            spec.clearPassword()
        }
    }

    private fun requirePassword(password: String) {
        if (password.length < 12) throw BackupFormatException("Use a backup password with at least 12 characters.")
    }

    private fun decodeBase64(value: String, expectedSize: Int?, field: String): ByteArray {
        val decoded = runCatching { Base64.getDecoder().decode(value) }
            .getOrElse { throw BackupFormatException("Backup $field is invalid.") }
        if (expectedSize != null && decoded.size != expectedSize) throw BackupFormatException("Backup $field is invalid.")
        return decoded
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(StandardCharsets.UTF_8))
        .joinToString("") { byte -> (byte.toInt() and 0xff).toString(16).padStart(2, '0') }
}
