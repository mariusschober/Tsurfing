package com.mariusschober.goalflow.nativeapp.sync

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.mariusschober.goalflow.nativeapp.data.GoalflowDatabase
import com.mariusschober.goalflow.nativeapp.data.GoalflowJson
import com.mariusschober.goalflow.nativeapp.data.GoalflowRepository
import com.mariusschober.goalflow.nativeapp.data.SyncConflictEntity
import com.mariusschober.goalflow.nativeapp.domain.GoalflowTask
import com.mariusschober.goalflow.nativeapp.domain.SchedulePrecision
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.net.SocketTimeoutException
import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class NativeSyncEngineTest {
    private lateinit var database: GoalflowDatabase
    private lateinit var repository: GoalflowRepository

    private val validSession = NativeSession(
        accessToken = "test-access-token",
        refreshToken = "test-refresh-token",
        expiresAtMillis = Long.MAX_VALUE,
        userId = "00000000-0000-4000-8000-000000000001"
    )

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        database = Room.inMemoryDatabaseBuilder(context, GoalflowDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        repository = GoalflowRepository(database, deviceId = "device-a")
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun `timeout after server commit retries the exact mutation id`() = runTest {
        repository.createTask(
            title = "Committed before timeout",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val originalMutationId = repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        var pushCalls = 0
        var retriedTaskCalls = 0
        var eventCalls = 0
        var committedMutationId: String? = null
        val transport = NativeSyncTransport { path, _, _, body ->
            when {
                path == "/api/v1/sync/push" -> {
                    val mutation = JSONObject(body!!)
                        .getJSONArray("mutations")
                        .getJSONObject(0)
                    val mutationId = mutation.getString("mutationId")
                    pushCalls += 1
                    if (pushCalls == 1) {
                        committedMutationId = mutationId
                        throw SocketTimeoutException("response lost after commit")
                    }
                    if (mutation.getString("entityType") == "tasks") {
                        assertEquals(committedMutationId, mutationId)
                        retriedTaskCalls += 1
                    } else {
                        assertEquals("task_events", mutation.getString("entityType"))
                        eventCalls += 1
                    }
                    NativeHttpResponse(
                        200,
                        JSONObject().put(
                            "results",
                            JSONArray().put(
                                JSONObject()
                                    .put("mutationId", mutationId)
                                    .put("accepted", true)
                                    .put("serverVersion", 1)
                                    .put("record", JSONObject()
                                        .put("entityType", mutation.getString("entityType"))
                                        .put("entityId", mutation.getString("entityId"))
                                        .put("deviceId", mutation.getString("deviceId"))
                                        .put("version", mutation.getLong("version"))
                                        .put("serverVersion", 1)
                                        .put("payload", mutation.get("payload"))
                                        .put("updatedAt", mutation.getString("updatedAt"))
                                        .put("deletedAt", mutation.get("deletedAt")))
                            )
                        ).toString()
                    )
                }
                path.startsWith("/api/v1/sync/pull") -> emptyPull()
                else -> throw AssertionError("Unexpected request: $path")
            }
        }
        val engine = engine(transport)

        engine.synchronize()

        assertEquals(3, pushCalls)
        assertEquals(1, retriedTaskCalls)
        assertEquals(1, eventCalls)
        assertTrue(repository.pendingSyncMutations().isEmpty())
    }

    @Test
    fun `401 during push preserves the pending mutation`() = runTest {
        repository.createTask(
            title = "Keep through auth expiry",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val mutationId = repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        val engine = engine(NativeSyncTransport { path, _, _, _ ->
            if (path == "/api/v1/sync/push") NativeHttpResponse(401, "{}")
            else throw AssertionError("Unexpected request: $path")
        })

        try {
            engine.synchronize()
            fail("Authentication expiry must be visible")
        } catch (_: AuthenticationExpiredDuringSync) {
            // Expected.
        }

        assertEquals(mutationId, repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId)
    }

    @Test
    fun `MFA required preserves the login and queued mutation until elevation`() = runTest {
        repository.createTask(
            title = "Keep while owner verifies MFA", notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(), scheduledTime = null, isFrog = false
        )
        val originalIds = repository.pendingSyncMutations().map { it.mutationId }.toSet()
        var currentSession = validSession
        val acknowledgedIds = mutableSetOf<String>()
        val engine = engine(
            transport = NativeSyncTransport { path, token, _, body ->
                if (currentSession.assuranceLevel != "aal2") {
                    NativeHttpResponse(403, "{\"error\":{\"code\":\"mfa_required\"}}")
                } else if (path == "/api/v1/sync/push") {
                    assertEquals("elevated-access-token", token)
                    acknowledgedIds += JSONObject(body!!).getJSONArray("mutations")
                        .getJSONObject(0).getString("mutationId")
                    acceptedPush(body)
                } else if (path.startsWith("/api/v1/sync/pull")) emptyPull()
                else throw AssertionError("Unexpected request: $path")
            },
            sessionProvider = NativeSessionProvider { currentSession }
        )
        try {
            engine.synchronize()
            fail("MFA must block sync")
        } catch (error: IllegalStateException) {
            assertTrue("MFA is not session expiry", error is NativeSyncMfaRequired)
        }
        assertEquals(validSession, currentSession)
        assertEquals(originalIds, repository.pendingSyncMutations().map { it.mutationId }.toSet())
        currentSession = validSession.copy(accessToken = "elevated-access-token", assuranceLevel = "aal2")
        engine.synchronize()
        assertEquals(originalIds, acknowledgedIds)
        assertTrue(repository.pendingSyncMutations().isEmpty())
    }

    @Test
    fun `MFA denial during account verification stops before any sync data is sent`() = runTest {
        var requests = 0
        val engine = NativeSyncEngine(
            repository = repository,
            sessionProvider = NativeSessionProvider { validSession },
            cloudAvailable = { true },
            transport = NativeSyncTransport { path, _, _, _ ->
                requests += 1
                assertEquals("/api/v1/sync/status", path)
                NativeHttpResponse(403, "{\"error\":{\"code\":\"mfa_required\"}}")
            }
        )
        try {
            engine.synchronize()
            fail("MFA must block sync")
        } catch (error: IllegalStateException) {
            assertTrue("MFA is not session expiry", error is NativeSyncMfaRequired)
        }
        assertEquals(1, requests)
    }

    @Test
    fun `non MFA access denials still invalidate synchronization authentication`() = runTest {
        for (response in listOf(
            NativeHttpResponse(401, "{\"error\":{\"code\":\"mfa_required\"}}"),
            NativeHttpResponse(403, "{\"error\":{\"code\":\"account_inactive\"}}"),
            NativeHttpResponse(403, "{}"),
            NativeHttpResponse(403, "invalid")
        )) {
            val engine = NativeSyncEngine(
                repository = repository,
                sessionProvider = NativeSessionProvider { validSession },
                cloudAvailable = { true },
                transport = NativeSyncTransport { _, _, _, _ -> response }
            )
            try {
                engine.synchronize()
                fail("Access denial must remain an authentication failure")
            } catch (error: IllegalStateException) {
                assertTrue(error is AuthenticationExpiredDuringSync)
            }
        }
    }

    @Test
    fun `transient server failure is bounded and preserves the pending mutation`() = runTest {
        repository.createTask(
            title = "Retry later",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val mutationId = repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        var pushCalls = 0
        val engine = engine(NativeSyncTransport { path, _, _, _ ->
            if (path != "/api/v1/sync/push") throw AssertionError("Unexpected request: $path")
            pushCalls += 1
            NativeHttpResponse(503, "{}")
        })

        try {
            engine.synchronize()
            fail("A bounded transient failure must remain visible")
        } catch (_: NativeSyncTransientException) {
            // WorkManager may retry later, but not indefinitely in one run.
        }

        assertEquals(3, pushCalls)
        assertEquals(mutationId, repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId)
    }

    @Test
    fun `logout while push is in flight discards the response but not the mutation`() = runTest {
        repository.createTask(
            title = "Keep through logout",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val mutationId = repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        var currentSession: NativeSession? = validSession
        val engine = engine(
            transport = NativeSyncTransport { path, _, _, body ->
                if (path != "/api/v1/sync/push") throw AssertionError("Unexpected request: $path")
                val response = acceptedPush(body!!)
                currentSession = null
                response
            },
            sessionProvider = NativeSessionProvider { currentSession }
        )

        try {
            engine.synchronize()
            fail("Logout must invalidate an in-flight acknowledgement")
        } catch (_: NativeSyncSessionChangedDuringSync) {
            // The server may have committed; the exact mutation remains retryable.
        }

        assertEquals(mutationId, repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId)
    }

    @Test
    fun `server identity mismatch stops before any local mutation is sent`() = runTest {
        repository.createTask(
            title = "Bound to the encrypted account",
            notes = "",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            scheduledTime = null,
            isFrog = false
        )
        val mutationId = repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId
        var pushCalls = 0
        val engine = engine(
            transport = NativeSyncTransport { path, _, _, _ ->
                if (path == "/api/v1/sync/push") pushCalls += 1
                throw AssertionError("Unexpected request: $path")
            },
            serverUserId = "00000000-0000-4000-8000-000000000099"
        )

        try {
            engine.synchronize()
            fail("A mismatched verified account must stop synchronization")
        } catch (_: NativeSyncProtocolException) {
            // Expected before the push boundary.
        }

        assertEquals(0, pushCalls)
        assertEquals(mutationId, repository.pendingSyncMutations().single { it.entityType == "tasks" }.mutationId)
    }

    @Test
    fun `duplicated acknowledgement cannot remove an unacknowledged mutation`() = runTest {
        repeat(2) { index ->
            repository.createTask(
                title = "Independent $index",
                notes = "",
                schedulePrecision = SchedulePrecision.DAY,
                scheduledFor = LocalDate.now().toString(),
                scheduledTime = null,
                isFrog = false
            )
        }
        val pendingIds = repository.pendingSyncMutations().map { it.mutationId }.toSet()
        val engine = engine(NativeSyncTransport { path, _, _, body ->
            if (path != "/api/v1/sync/push") throw AssertionError("Unexpected request: $path")
            val firstId = JSONObject(body!!).getJSONArray("mutations").getJSONObject(0).getString("mutationId")
            val duplicate = JSONObject()
                .put("mutationId", firstId)
                .put("accepted", true)
                .put("serverVersion", 1)
            NativeHttpResponse(
                200,
                JSONObject().put("results", JSONArray().put(duplicate).put(JSONObject(duplicate.toString()))).toString()
            )
        })

        try {
            engine.synchronize()
            fail("A mismatched acknowledgement set must be rejected")
        } catch (_: NativeSyncProtocolException) {
            // Expected.
        }

        assertEquals(pendingIds, repository.pendingSyncMutations().map { it.mutationId }.toSet())
    }

    @Test
    fun `pull cursor cannot advance beyond the highest returned record`() = runTest {
        val remote = GoalflowTask(
            id = "00000000-0000-4000-8000-000000000002",
            title = "Must not be silently skipped",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            createdAt = 1,
            updatedAt = 2
        )
        val response = JSONObject()
            .put(
                "records",
                JSONArray().put(
                    JSONObject()
                        .put("entityType", "tasks")
                        .put("entityId", remote.id)
                        .put("version", 1)
                        .put("serverVersion", 5)
                        .put("deviceId", "device-b")
                        .put("payload", GoalflowJson.taskPayload(remote))
                        .put("updatedAt", Instant.now().toString())
                        .put("deletedAt", JSONObject.NULL)
                )
            )
            .put("nextCursor", 6)
            .put("hasMore", false)
        val engine = engine(NativeSyncTransport { path, _, _, _ ->
            if (path.startsWith("/api/v1/sync/pull")) NativeHttpResponse(200, response.toString())
            else throw AssertionError("Unexpected request: $path")
        })

        try {
            engine.synchronize()
            fail("An unsafe cursor must abort the page")
        } catch (_: NativeSyncProtocolException) {
            // Expected.
        }

        assertNull(database.taskDao().get(remote.id))
        assertNull(repository.syncMetadata("_cursor"))
    }

    @Test
    fun `pull record without durable timestamp cannot advance the cursor`() = runTest {
        val remote = GoalflowTask(
            id = "00000000-0000-4000-8000-000000000003",
            title = "Missing server timestamp",
            schedulePrecision = SchedulePrecision.DAY,
            scheduledFor = LocalDate.now().toString(),
            createdAt = 1,
            updatedAt = 2
        )
        val response = JSONObject()
            .put(
                "records",
                JSONArray().put(
                    JSONObject()
                        .put("entityType", "tasks")
                        .put("entityId", remote.id)
                        .put("version", 1)
                        .put("serverVersion", 1)
                        .put("deviceId", "device-b")
                        .put("payload", GoalflowJson.taskPayload(remote))
                        .put("deletedAt", JSONObject.NULL)
                )
            )
            .put("nextCursor", 1)
            .put("hasMore", false)
        val engine = engine(NativeSyncTransport { path, _, _, _ ->
            if (path.startsWith("/api/v1/sync/pull")) NativeHttpResponse(200, response.toString())
            else throw AssertionError("Unexpected request: $path")
        })

        try {
            engine.synchronize()
            fail("A record without its durable timestamp must be rejected")
        } catch (_: NativeSyncProtocolException) {
            // The record and cursor remain unapplied.
        }

        assertNull(database.taskDao().get(remote.id))
        assertNull(repository.syncMetadata("_cursor"))
    }

    @Test
    fun `cloud conflict requires an exact durable server acknowledgement`() = runTest {
        val conflict = SyncConflictEntity(
            id = "99999999-9999-4999-8999-999999999999",
            entityType = "tasks",
            entityId = "00000000-0000-4000-8000-000000000004",
            mutationId = "88888888-8888-4888-8888-888888888888",
            localPayload = "{\"id\":\"00000000-0000-4000-8000-000000000004\",\"title\":\"local\"}",
            serverPayload = "{\"id\":\"00000000-0000-4000-8000-000000000004\",\"title\":\"cloud\"}",
            serverVersion = 2,
            createdAt = "2026-09-03T00:00:00Z"
        )
        database.syncConflictDao().insert(conflict)
        var submitted: JSONObject? = null
        val engine = engine(NativeSyncTransport { path, _, _, body ->
            if (path != "/api/v1/sync/conflicts/resolve") throw AssertionError("Unexpected request: $path")
            submitted = JSONObject(body!!)
            NativeHttpResponse(
                200,
                JSONObject()
                    .put("resolved", true)
                    .put("conflictId", "77777777-7777-4777-8777-777777777777")
                    .put("mutationId", conflict.mutationId)
                    .toString()
            )
        })

        try {
            engine.resolveConflictWithCloud(conflict)
            fail("A mismatched server acknowledgement must remain visible")
        } catch (_: NativeSyncProtocolException) {
            // Both sides remain in Room.
        }

        assertEquals(conflict.id, submitted?.getString("conflictId"))
        assertEquals(conflict.mutationId, submitted?.getString("mutationId"))
        assertEquals(conflict, database.syncConflictDao().get(conflict.id))
    }

    @Test
    fun hostedBrowserRecordConvergesThroughProductionTransport() = runTest {
        assumeTrue(
            "The live transport proof runs only inside the explicit staging cross-client gate.",
            System.getenv("GOALFLOW_HOSTED_TEST_CONFIRM") == "staging" &&
                System.getenv("GOALFLOW_CROSS_CLIENT_PHASE") == "android"
        )
        val state = JSONObject(File(hostedEnvironment("GOALFLOW_CROSS_CLIENT_STATE_FILE")).readText())
        assertEquals("The cross-client handoff schema is invalid.", 1, state.getInt("schemaVersion"))
        val taskId = state.getString("taskId")
        val browserTitle = state.getString("browserTitle")
        val androidTitle = state.getString("androidTitle")
        val appOrigin = hostedOrigin("GOALFLOW_STAGING_APP_ORIGIN")
        val supabaseUrl = hostedOrigin("GOALFLOW_STAGING_SUPABASE_URL")
        val publishableKey = hostedEnvironment("GOALFLOW_STAGING_SUPABASE_PUBLISHABLE_KEY")
        assertTrue("A server credential must never enter the native gate.", publishableKey.startsWith("sb_publishable_"))
        assertEquals(appOrigin, NativeConfig.apiOrigin)
        assertEquals(supabaseUrl, NativeConfig.supabaseUrl)
        assertEquals(publishableKey, NativeConfig.supabasePublicKey)

        val session = hostedPasswordSession(supabaseUrl, publishableKey)
        val expectedUserId = hostedEnvironment("GOALFLOW_STAGING_USER_A_ID")
        assertEquals(expectedUserId, session.userId)
        val engine = NativeSyncEngine(
            repository = repository,
            sessionProvider = NativeSessionProvider { session }
        )

        val initialResult = engine.synchronize()
        assertEquals(SyncResult.Synced(conflicts = 0), initialResult)
        val browserTask = repository.taskSnapshot(taskId)
            ?: throw AssertionError("The production Android transport did not pull the browser task.")
        assertEquals(browserTitle, browserTask.title)

        repository.updateTask(
            id = browserTask.id,
            title = androidTitle,
            notes = browserTask.notes,
            schedulePrecision = browserTask.schedulePrecision,
            scheduledFor = browserTask.scheduledFor,
            scheduledTime = browserTask.scheduledTime,
            isFrog = browserTask.isFrog,
            goalId = browserTask.goalId
        )
        val pending = repository.pendingSyncMutations().single {
            it.entityType == "tasks" && it.entityId == taskId
        }
        assertEquals(androidTitle, JSONObject(pending.payload).getString("title"))

        val editResult = engine.synchronize()
        assertEquals(SyncResult.Synced(conflicts = 0), editResult)
        assertTrue(repository.pendingSyncMutations().none { it.entityId == taskId })
        assertEquals(androidTitle, repository.taskSnapshot(taskId)?.title)
    }

    private fun hostedPasswordSession(supabaseUrl: String, publishableKey: String): NativeSession {
        val client = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(25, TimeUnit.SECONDS)
            .build()
        val body = JSONObject()
            .put("email", hostedEnvironment("GOALFLOW_STAGING_USER_A_EMAIL"))
            .put("password", hostedEnvironment("GOALFLOW_STAGING_USER_A_PASSWORD"))
            .toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("$supabaseUrl/auth/v1/token?grant_type=password")
            .header("apikey", publishableKey)
            .header("Authorization", "Bearer $publishableKey")
            .header("Accept", "application/json")
            .post(body)
            .build()
        val responseBody = client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw AssertionError("Staging password authentication failed with HTTP ${response.code}.")
            }
            readNativeSyncResponse(response.body, maximumBytes = 1024 * 1024)
        }
        val response = JSONObject(responseBody)
        val userId = response.getJSONObject("user").getString("id")
        val expiresInSeconds = response.getLong("expires_in")
        assertTrue("The staging session has an unsafe lifetime.", expiresInSeconds in 60L..86_400L)
        return NativeSession(
            accessToken = response.getString("access_token"),
            refreshToken = response.getString("refresh_token"),
            expiresAtMillis = System.currentTimeMillis() + expiresInSeconds * 1_000L,
            userId = userId
        )
    }

    private fun hostedEnvironment(name: String): String =
        System.getenv(name)?.trim()?.takeIf(String::isNotEmpty)
            ?: throw AssertionError("Missing required hosted staging setting: $name")

    private fun hostedOrigin(name: String): String {
        val value = hostedEnvironment(name).trimEnd('/')
        val uri = URI(value)
        assertEquals("https", uri.scheme)
        assertTrue("Hosted origins must not contain credentials.", uri.userInfo == null)
        assertTrue("Hosted origins must not contain a path.", uri.path.isNullOrEmpty() || uri.path == "/")
        assertTrue("Hosted origins must not contain a query or fragment.", uri.query == null && uri.fragment == null)
        return value
    }

    private fun engine(
        transport: NativeSyncTransport,
        sessionProvider: NativeSessionProvider = NativeSessionProvider { validSession },
        serverUserId: String = validSession.userId!!
    ): NativeSyncEngine = NativeSyncEngine(
        repository = repository,
        sessionProvider = sessionProvider,
        transport = NativeSyncTransport { path, token, method, body ->
            when (path) {
                "/api/v1/sync/status" -> NativeHttpResponse(
                    200,
                    JSONObject().put("userId", serverUserId).put("serverVersion", 0)
                        .put("unresolvedConflicts", 0).toString()
                )
                "/api/v1/sync/conflicts" -> NativeHttpResponse(
                    200,
                    JSONObject().put("conflicts", JSONArray()).toString()
                )
                else -> transport.request(path, token, method, body)
            }
        },
        cloudAvailable = { true },
        retryPolicy = NativeSyncRetryPolicy(
            initialDelayMillis = 0,
            maximumDelayMillis = 0,
            jitterMillis = { 0 },
            wait = {}
        )
    )

    private fun acceptedPush(body: String): NativeHttpResponse {
        val mutation = JSONObject(body).getJSONArray("mutations").getJSONObject(0)
        return NativeHttpResponse(
            200,
            JSONObject().put(
                "results",
                JSONArray().put(
                    JSONObject()
                        .put("mutationId", mutation.getString("mutationId"))
                        .put("accepted", true)
                        .put("serverVersion", 1)
                        .put("record", JSONObject()
                            .put("entityType", mutation.getString("entityType"))
                            .put("entityId", mutation.getString("entityId"))
                            .put("deviceId", mutation.getString("deviceId"))
                            .put("version", mutation.getLong("version"))
                            .put("serverVersion", 1)
                            .put("payload", mutation.get("payload"))
                            .put("updatedAt", mutation.getString("updatedAt"))
                            .put("deletedAt", mutation.get("deletedAt")))
                )
            ).toString()
        )
    }

    private fun emptyPull(): NativeHttpResponse = NativeHttpResponse(
        200,
        JSONObject()
            .put("records", JSONArray())
            .put("nextCursor", 0)
            .put("hasMore", false)
            .toString()
    )
}
