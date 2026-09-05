package com.mariusschober.goalflow.nativeapp.sync

import com.mariusschober.goalflow.nativeapp.data.GoalflowRepository
import com.mariusschober.goalflow.nativeapp.data.NativePushResult
import com.mariusschober.goalflow.nativeapp.data.NativeRemoteRecord
import com.mariusschober.goalflow.nativeapp.data.NativeServerConflict
import com.mariusschober.goalflow.nativeapp.data.SyncConflictEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.ConnectionPool
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.ResponseBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

// P1-5: OkHttp singleton with HTTP/2 + 30s pool for NativeSyncEngine
internal val nativeOkHttpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(25, TimeUnit.SECONDS)
        .connectionPool(ConnectionPool(5, 5, TimeUnit.MINUTES))
        .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
        .build()
}

sealed interface SyncResult {
    data object Skipped : SyncResult
    data class Synced(val conflicts: Int) : SyncResult
}

data class NativeHttpResponse(val code: Int, val body: String)

fun interface NativeSyncTransport {
    fun request(path: String, token: String, method: String, body: String?): NativeHttpResponse
}

class AuthenticationExpiredDuringSync : IllegalStateException("Authentication expired during synchronization.")
class NativeSyncMfaRequired : IllegalStateException("Verify the owner session before cloud synchronization.")
class NativeSyncSessionChangedDuringSync : IllegalStateException(
    "The local cloud session changed while synchronization was running. Local changes remain pending."
)
class NativeSyncProtocolException(message: String) : IllegalStateException(message)
class NativeSyncTransientException(message: String, cause: Throwable? = null) : IOException(message, cause)
private const val MAX_NATIVE_SYNC_RESPONSE_BYTES = 16 * 1024 * 1024

internal fun readNativeSyncResponse(
    body: ResponseBody?,
    maximumBytes: Int = MAX_NATIVE_SYNC_RESPONSE_BYTES
): String {
    require(maximumBytes > 0) { "A positive response limit is required." }
    if (body == null) return ""
    val declaredLength = body.contentLength()
    if (declaredLength > maximumBytes) {
        throw NativeSyncProtocolException("The synchronization response exceeded the safe client limit.")
    }
    val output = ByteArrayOutputStream()
    body.byteStream().use { stream ->
        val buffer = ByteArray(8_192)
        while (true) {
            val count = stream.read(buffer)
            if (count < 0) break
            if (count > maximumBytes - output.size()) {
                throw NativeSyncProtocolException("The synchronization response exceeded the safe client limit.")
            }
            output.write(buffer, 0, count)
        }
    }
    return String(output.toByteArray(), StandardCharsets.UTF_8)
}

data class NativeSyncRetryPolicy(
    val maxAttempts: Int = 3,
    val initialDelayMillis: Long = 500L,
    val maximumDelayMillis: Long = 5_000L,
    val jitterMillis: () -> Long = { Random.nextLong(0L, 251L) },
    val wait: suspend (Long) -> Unit = { delay(it) }
) {
    init {
        require(maxAttempts in 1..5)
        require(initialDelayMillis in 0L..maximumDelayMillis)
        require(maximumDelayMillis <= 30_000L)
    }
}

/**
 * At-least-once sync adapter. Network responses never mutate Room piecemeal:
 * the repository commits acknowledgements, conflicts, records, and cursors in
 * explicit transactions. Therefore a timeout or process death only causes a
 * retry of the same mutation id.
 */
class NativeSyncEngine(
    private val repository: GoalflowRepository,
    private val sessionProvider: NativeSessionProvider,
    private val transport: NativeSyncTransport = NativeSyncTransport(::httpRequest),
    private val cloudAvailable: () -> Boolean = { NativeConfig.canUseCloud },
    private val retryPolicy: NativeSyncRetryPolicy = NativeSyncRetryPolicy()
) {
    private val synchronizationMutex = Mutex()

    suspend fun resolveConflictWithCloud(conflict: SyncConflictEntity) = withContext(Dispatchers.IO) {
        val serverLedgerConflict = runCatching { java.util.UUID.fromString(conflict.id) }.isSuccess
        if (serverLedgerConflict) {
            if (!cloudAvailable()) {
                throw NativeSyncProtocolException("The server conflict cannot be resolved while cloud access is unavailable; both versions remain preserved.")
            }
            val mutationId = conflict.mutationId?.takeIf { it.matches(UUID_PATTERN) }
                ?: throw NativeSyncProtocolException("The server conflict identity is invalid; both versions remain preserved.")
            val session = sessionProvider.read() ?: throw AuthenticationExpiredDuringSync()
            if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
                throw AuthenticationExpiredDuringSync()
            }
            repository.bindSyncAccount(verifiedUserId(session))
            val response = requestForSession(
                session,
                "/api/v1/sync/conflicts/resolve",
                "POST",
                JSONObject()
                    .put("conflictId", conflict.id)
                    .put("mutationId", mutationId)
                    .put("choice", "cloud")
                    .toString()
            )
            ensureSuccessful(response, "The server conflict could not be resolved; both versions remain preserved.")
            val acknowledgment = parseObject(
                response.body,
                "The server conflict response was invalid; both versions remain preserved."
            )
            if (acknowledgment.opt("resolved") !is Boolean
                || !acknowledgment.getBoolean("resolved")
                || acknowledgment.optString("conflictId") != conflict.id
                || acknowledgment.optString("mutationId") != mutationId
            ) {
                throw NativeSyncProtocolException("The server did not acknowledge the exact conflict; both versions remain preserved.")
            }
        }
        repository.resolveConflictWithCloud(conflict.id)
    }

    suspend fun synchronize(): SyncResult = synchronizationMutex.withLock { synchronizeOnce() }

    private suspend fun synchronizeOnce(): SyncResult = withContext(Dispatchers.IO) {
        if (!cloudAvailable()) return@withContext SyncResult.Skipped
        val session = sessionProvider.read() ?: return@withContext SyncResult.Skipped
        if (session.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            return@withContext SyncResult.Skipped
        }
        repository.bindSyncAccount(verifiedUserId(session))

        var conflicts = 0
        while (true) {
            val batch = repository.readySyncMutations(50)
            if (batch.isEmpty()) break
            repository.markSyncAttempted(batch.map { it.mutationId })
            val mutations = JSONArray().apply {
                batch.forEach { mutation -> put(JSONObject().apply {
                    put("mutationId", mutation.mutationId)
                    put("deviceId", mutation.deviceId)
                    put("entityType", mutation.entityType)
                    put("entityId", mutation.entityId)
                    put("baseServerVersion", mutation.baseServerVersion ?: JSONObject.NULL)
                    put("version", mutation.version)
                    put("payload", parseJsonValue(mutation.payload))
                    put("updatedAt", mutation.updatedAt)
                    put("deletedAt", mutation.deletedAt ?: JSONObject.NULL)
                    mutation.resolvesConflictId
                        ?.takeIf { it.matches(UUID_PATTERN) }
                        ?.let { put("resolvesConflictId", it) }
                }) }
            }
            val response = requestForSession(
                session,
                "/api/v1/sync/push",
                "POST",
                JSONObject().put("mutations", mutations).toString()
            )
            ensureSuccessful(response, "Sync push failed. Local changes remain pending.")
            val body = parseObject(response.body, "Sync push response is not valid JSON.")
            val array = body.optJSONArray("results")
                ?: throw NativeSyncProtocolException("Sync push response has no result set.")
            if (array.length() != batch.size) {
                throw NativeSyncProtocolException("Sync push response has an incomplete acknowledgement set.")
            }
            val results = buildList(array.length()) {
                for (index in 0 until array.length()) {
                    val result = array.optJSONObject(index)
                        ?: throw NativeSyncProtocolException("Sync push response contains an invalid result.")
                    val acceptedValue = result.opt("accepted")
                    val mutationIdValue = result.opt("mutationId")
                    val serverVersionValue = result.opt("serverVersion")
                    if (acceptedValue !is Boolean || mutationIdValue !is String || mutationIdValue.isBlank()
                        || serverVersionValue !is Number
                        || (result.has("replayMismatch") && result.opt("replayMismatch") !is Boolean)
                        || (result.has("serverMissing") && result.opt("serverMissing") !is Boolean)
                    ) {
                        throw NativeSyncProtocolException("Sync push response contains an ambiguous result.")
                    }
                    val record = result.optJSONObject("record")
                    val recordEntityType = record?.optString("entityType")?.takeIf(String::isNotBlank)
                        ?: record?.optString("entity_type")?.takeIf(String::isNotBlank)
                    val recordEntityId = record?.optString("entityId")?.takeIf(String::isNotBlank)
                        ?: record?.optString("entity_id")?.takeIf(String::isNotBlank)
                    val recordDeviceIdValue = record?.let {
                        when {
                            it.has("deviceId") -> it.opt("deviceId")
                            it.has("device_id") -> it.opt("device_id")
                            else -> null
                        }
                    }
                    val recordDeviceId = when (recordDeviceIdValue) {
                        null, JSONObject.NULL -> null
                        is String -> recordDeviceIdValue.takeIf(String::isNotBlank)
                            ?: throw NativeSyncProtocolException("Sync push response contains an invalid record device identity.")
                        else -> throw NativeSyncProtocolException("Sync push response contains an invalid record device identity.")
                    }
                    val recordVersion = record?.let {
                        if (!it.has("version")) null else safeLong(it.opt("version"), "accepted record version")
                    }
                    val recordServerVersion = record?.let {
                        val value = if (it.has("serverVersion")) it.opt("serverVersion") else it.opt("server_version")
                        if (value == null || value == JSONObject.NULL) null
                        else safeLong(value, "accepted record server version", allowZero = false)
                    }
                    val recordPayload = record?.opt("payload")?.let(::jsonValueText)
                    val recordUpdatedAt = record?.nullableString("updatedAt")
                        ?: record?.nullableString("updated_at")
                    val recordDeletedAt = record?.nullableString("deletedAt")
                        ?: record?.nullableString("deleted_at")
                    add(
                        NativePushResult(
                            mutationId = mutationIdValue,
                            accepted = acceptedValue,
                            serverVersion = safeLong(serverVersionValue, "acknowledgement server version", allowZero = !acceptedValue),
                            conflictId = result.nullableString("conflictId"),
                            replayMismatch = result.optBoolean("replayMismatch", false),
                            serverMissing = result.optBoolean("serverMissing", false),
                            serverPayload = record?.opt("payload")?.let(::jsonValueText).orEmpty(),
                            serverDeletedAt = recordDeletedAt,
                            recordEntityType = recordEntityType,
                            recordEntityId = recordEntityId,
                            recordDeviceId = recordDeviceId,
                            recordVersion = recordVersion,
                            recordServerVersion = recordServerVersion,
                            recordPayload = recordPayload,
                            recordUpdatedAt = recordUpdatedAt,
                            recordDeletedAt = recordDeletedAt
                        )
                    )
                }
            }
            val expectedIds = batch.map { it.mutationId }.toSet()
            if (results.map { it.mutationId }.toSet() != expectedIds || results.map { it.mutationId }.distinct().size != results.size) {
                throw NativeSyncProtocolException("Sync push response acknowledged the wrong mutation ids.")
            }
            conflicts += repository.commitPushResults(batch, results)
        }

        var cursor = repository.syncMetadata(SYNC_CURSOR_KEY)?.cursor ?: 0L
        var hasMore: Boolean
        do {
            val response = requestForSession(
                session,
                "/api/v1/sync/pull?cursor=$cursor&limit=100",
                "GET",
                null
            )
            ensureSuccessful(response, "Sync pull failed. The local cursor was not advanced.")
            val body = parseObject(response.body, "Sync pull response is not valid JSON.")
            val array = body.optJSONArray("records")
                ?: throw NativeSyncProtocolException("Sync pull response has no record set.")
            val nextCursorValue = body.opt("nextCursor")
            val hasMoreValue = body.opt("hasMore")
            if (nextCursorValue !is Number || hasMoreValue !is Boolean) {
                throw NativeSyncProtocolException("Sync pull response has an invalid cursor envelope.")
            }
            val nextCursor = safeLong(nextCursorValue, "sync cursor")
            hasMore = hasMoreValue
            if (nextCursor < cursor || (hasMore && nextCursor == cursor)) {
                throw NativeSyncProtocolException("Sync pull cursor did not make safe progress.")
            }
            val records = buildList(array.length()) {
                for (index in 0 until array.length()) {
                    val record = array.optJSONObject(index)
                        ?: throw NativeSyncProtocolException("Sync pull response contains an invalid record.")
                    val payload = record.opt("payload")
                        ?: throw NativeSyncProtocolException("Sync pull record has no payload.")
                    val entityType = record.opt("entityType")
                    val entityId = record.opt("entityId")
                    val version = record.opt("version")
                    val serverVersion = record.opt("serverVersion")
                    val deviceId = record.opt("deviceId")
                    val updatedAt = record.opt("updatedAt")
                    if (entityType !is String || entityType.isBlank()
                        || entityId !is String || entityId.isBlank()
                        || version !is Number || serverVersion !is Number
                        || deviceId !is String || deviceId.isBlank()
                        || updatedAt !is String || runCatching { Instant.parse(updatedAt) }.isFailure
                        || !record.has("deletedAt")
                        || (record.has("deletedAt") && !record.isNull("deletedAt") && record.opt("deletedAt") !is String)
                    ) {
                        throw NativeSyncProtocolException("Sync pull response contains an ambiguous record.")
                    }
                    add(
                        NativeRemoteRecord(
                            entityType = entityType,
                            entityId = entityId,
                            version = safeLong(version, "remote record version"),
                            serverVersion = safeLong(serverVersion, "remote server version", allowZero = false),
                            deviceId = deviceId,
                            payload = jsonValueText(payload),
                            updatedAt = updatedAt,
                            deletedAt = record.nullableString("deletedAt")
                        )
                    )
                }
            }
            val highestReturned = records.maxOfOrNull { it.serverVersion } ?: cursor
            if (nextCursor != highestReturned) {
                throw NativeSyncProtocolException("Sync pull cursor would skip or discard remote information.")
            }
            conflicts += repository.applyRemotePage(records, nextCursor)
            cursor = nextCursor
        } while (hasMore)

        val conflictResponse = requestForSession(
            session,
            "/api/v1/sync/conflicts",
            "GET",
            null
        )
        ensureSuccessful(conflictResponse, "Server conflicts could not be verified; existing local state was not changed.")
        val conflictBody = parseObject(conflictResponse.body, "Sync conflict response is not valid JSON.")
        val conflictArray = conflictBody.optJSONArray("conflicts")
            ?: throw NativeSyncProtocolException("Sync conflict response has no conflict set.")
        val serverConflicts = buildList(conflictArray.length()) {
            for (index in 0 until conflictArray.length()) {
                val conflict = conflictArray.optJSONObject(index)
                    ?: throw NativeSyncProtocolException("Sync conflict response contains an invalid conflict.")
                fun value(camel: String, snake: String): Any? =
                    if (conflict.has(camel)) conflict.opt(camel) else conflict.opt(snake)
                fun string(camel: String, snake: String): String? =
                    (value(camel, snake) as? String)?.takeIf(String::isNotBlank)
                fun nullableDate(camel: String, snake: String): String? {
                    val candidate = value(camel, snake)
                    return when (candidate) {
                        null, JSONObject.NULL -> null
                        is String -> candidate.takeIf(String::isNotBlank)
                        else -> throw NativeSyncProtocolException("Sync conflict contains an invalid timestamp.")
                    }
                }
                val id = conflict.optString("id").takeIf(String::isNotBlank)
                val entityType = string("entityType", "entity_type")
                val entityId = string("entityId", "entity_id")
                val mutationId = string("mutationId", "mutation_id")
                val localPayloadPresent = conflict.has("localPayload") || conflict.has("local_payload")
                val localPayload = if (localPayloadPresent) {
                    jsonValueText(value("localPayload", "local_payload") ?: JSONObject.NULL)
                } else null
                val serverMissingValue = value("serverMissing", "server_missing")
                if (serverMissingValue != null && serverMissingValue !== JSONObject.NULL && serverMissingValue !is Boolean) {
                    throw NativeSyncProtocolException("Sync conflict contains an invalid missing-record flag.")
                }
                val serverMissing = serverMissingValue == true
                val serverPayloadPresent = conflict.has("serverPayload") || conflict.has("server_payload")
                val serverPayload = if (serverPayloadPresent) {
                    jsonValueText(value("serverPayload", "server_payload") ?: JSONObject.NULL)
                } else ""
                val localVersionValue = value("localVersion", "local_version")
                val localVersion = if (localVersionValue == null || localVersionValue === JSONObject.NULL) 1L
                    else safeLong(localVersionValue, "conflict local version", allowZero = false)
                val serverVersionValue = value("serverVersion", "server_version")
                val serverVersion = if (serverVersionValue == null || serverVersionValue === JSONObject.NULL) null
                    else safeLong(serverVersionValue, "conflict server version")
                val createdAt = string("createdAt", "created_at")
                val localUpdatedAt = string("localUpdatedAt", "local_updated_at") ?: createdAt
                if (id == null || !id.matches(UUID_PATTERN) || entityType == null || entityId == null
                    || mutationId == null || !mutationId.matches(UUID_PATTERN) || localPayload == null
                    || (!serverMissing && !serverPayloadPresent) || serverVersion == null
                    || createdAt == null || localUpdatedAt == null
                ) {
                    throw NativeSyncProtocolException("Sync conflict response contains incomplete recovery data.")
                }
                add(NativeServerConflict(
                    id = id,
                    entityType = entityType,
                    entityId = entityId,
                    mutationId = mutationId,
                    localPayload = localPayload,
                    localDeletedAt = nullableDate("localDeletedAt", "local_deleted_at"),
                    localVersion = localVersion,
                    localUpdatedAt = localUpdatedAt,
                    serverPayload = serverPayload,
                    serverDeletedAt = nullableDate("serverDeletedAt", "server_deleted_at"),
                    serverVersion = serverVersion,
                    serverMissing = serverMissing,
                    createdAt = createdAt
                ))
            }
        }
        conflicts += repository.mergeServerConflicts(serverConflicts)

        repository.markSyncSuccessful()
        SyncResult.Synced(conflicts)
    }

    private fun ensureAuthorized(response: NativeHttpResponse) {
        if (response.code == 403) {
            val errorCode = runCatching {
                JSONObject(response.body).optJSONObject("error")?.optString("code")
            }.getOrNull()
            if (errorCode == "mfa_required") throw NativeSyncMfaRequired()
        }
        if (response.code == 401 || response.code == 403) throw AuthenticationExpiredDuringSync()
    }

    private fun ensureSuccessful(response: NativeHttpResponse, message: String) {
        ensureAuthorized(response)
        if (response.code in 200..299) return
        if (isRetryableStatus(response.code)) throw NativeSyncTransientException(message)
        throw NativeSyncProtocolException(message)
    }

    private fun requireUnchangedSession(expected: NativeSession) {
        val current = sessionProvider.read() ?: throw NativeSyncSessionChangedDuringSync()
        if (current != expected || current.expiresAtMillis <= System.currentTimeMillis() + 60_000L) {
            throw NativeSyncSessionChangedDuringSync()
        }
    }

    private suspend fun requestForSession(
        session: NativeSession,
        path: String,
        method: String,
        body: String?
    ): NativeHttpResponse {
        var lastFailure: IOException? = null
        for (attempt in 0 until retryPolicy.maxAttempts) {
            requireUnchangedSession(session)
            val response = try {
                transport.request(path, session.accessToken, method, body)
            } catch (error: IOException) {
                requireUnchangedSession(session)
                lastFailure = error
                if (attempt + 1 >= retryPolicy.maxAttempts) {
                    throw NativeSyncTransientException("Synchronization could not reach the server.", error)
                }
                waitBeforeRetry(attempt)
                continue
            }
            // A logout or token/account replacement while the request was in
            // flight invalidates the response. The server may have committed;
            // keeping the exact mutation ID pending makes the next retry safe.
            requireUnchangedSession(session)
            ensureAuthorized(response)
            if (!isRetryableStatus(response.code) || attempt + 1 >= retryPolicy.maxAttempts) return response
            waitBeforeRetry(attempt)
        }
        throw NativeSyncTransientException("Synchronization could not reach the server.", lastFailure)
    }

    private suspend fun waitBeforeRetry(attempt: Int) {
        val exponential = min(
            retryPolicy.initialDelayMillis * (1L shl attempt.coerceAtMost(10)),
            retryPolicy.maximumDelayMillis
        )
        val jitter = retryPolicy.jitterMillis().coerceIn(0L, 1_000L)
        retryPolicy.wait(exponential + jitter)
    }

    private suspend fun verifiedUserId(session: NativeSession): String {
        val response = requestForSession(session, "/api/v1/sync/status", "GET", null)
        ensureSuccessful(response, "The authenticated sync account could not be verified.")
        val userId = parseObject(response.body, "Sync account response is not valid JSON.")
            .optString("userId").trim()
        if (!userId.matches(UUID_PATTERN)) {
            throw NativeSyncProtocolException("The authenticated sync account has no stable identity.")
        }
        if (session.userId != null && session.userId != userId) {
            throw NativeSyncProtocolException("The authenticated server account did not match the encrypted native session.")
        }
        return userId
    }

    private companion object {
        const val SYNC_CURSOR_KEY = "_cursor"
        val RETRYABLE_STATUS = setOf(408, 425, 429)
        val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")

        fun parseObject(value: String, message: String): JSONObject =
            runCatching { JSONObject(value) }.getOrElse { throw NativeSyncProtocolException(message) }

        fun parseJsonValue(value: String): Any = runCatching<Any> { JSONObject(value) }
            .recoverCatching { JSONArray(value) }
            .recoverCatching { JSONArray("[$value]").get(0) }
            .getOrElse { throw NativeSyncProtocolException("A pending mutation contains invalid JSON.") }

        fun jsonValueText(value: Any): String {
            if (value === JSONObject.NULL) return "null"
            return when (value) {
                is JSONObject, is JSONArray -> value.toString()
                is String -> JSONObject.quote(value)
                is Number, is Boolean -> value.toString()
                else -> throw NativeSyncProtocolException("A sync payload is not valid JSON.")
            }
        }

        fun safeLong(value: Any?, field: String, allowZero: Boolean = true): Long {
            if (value !is Number) throw NativeSyncProtocolException("The sync response contains an invalid $field.")
            val result = value.toLong()
            val doubleValue = value.toDouble()
            if (!doubleValue.isFinite()
                || doubleValue != result.toDouble()
                || doubleValue > MAX_SAFE_JSON_INTEGER
                || result < 0L
                || (!allowZero && result == 0L)
            ) {
                throw NativeSyncProtocolException("The sync response contains an invalid $field.")
            }
            return result
        }

        const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991.0
        fun isRetryableStatus(code: Int): Boolean = code >= 500 || code in RETRYABLE_STATUS

        fun JSONObject.nullableString(key: String): String? =
            if (!has(key) || isNull(key)) null else optString(key).takeIf(String::isNotBlank)

        fun httpRequest(path: String, token: String, method: String, body: String?): NativeHttpResponse {
            val url = "${NativeConfig.apiOrigin}$path"
            val builder = Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .header("Cache-Control", "no-store")
                .header("Authorization", "Bearer $token")
            val requestBody = body?.toRequestBody("application/json".toMediaType())
            val request = when (method) {
                "POST" -> builder.post(requestBody ?: "".toRequestBody(null))
                "GET" -> builder.get()
                else -> builder.method(method, requestBody)
            }.build()
            nativeOkHttpClient.newCall(request).execute().use { response ->
                val code = response.code
                val responseBody = readNativeSyncResponse(response.body)
                return NativeHttpResponse(code, responseBody)
            }
        }
    }
}
