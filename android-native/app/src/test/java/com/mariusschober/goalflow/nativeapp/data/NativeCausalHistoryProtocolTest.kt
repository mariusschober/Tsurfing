package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import com.mariusschober.goalflow.nativeapp.sync.NativeCausalTransport
import com.mariusschober.goalflow.nativeapp.sync.NativeHttpResponse
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.Base64

@RunWith(RobolectricTestRunner::class)
class NativeCausalHistoryProtocolTest {
    private fun fixture(): JSONObject {
        val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "tests/fixtures/s2/action-receipts-v2.json").isFile }
        return JSONObject(File(root, "tests/fixtures/s2/action-receipts-v2.json").readText())
    }

    @Test fun `Room resumes partial history and failed commit cannot advance progress or clear local commands`() = runTest {
        val fixture = fixture(); val owner = fixture.getString("accountId")
        val entry = fixture.getJSONObject("cutover").put("unknown", "界".repeat(40_000))
        val position = NativeCausalHistoryPosition(entry.getString("epoch"), 0, 0)
        val parts = chunks(owner, position, entry.toString())
        val database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), GoalflowDatabase::class.java)
            .allowMainThreadQueries().build()
        try {
            val repository = GoalflowRepository(database, "fixture")
            repository.bindSyncAccount(owner); repository.prepareCausalAccount(owner)
            val mirror = database.rawCollectionDao().get("tracking"); val outbox = database.syncOutboxDao().getAll()
            val meta = database.syncMetaDao().getAll()
            val store = NativeCausalHistoryStore(database)
            store.begin(owner, position.epoch, 0)
            val fetched = NativeCausalTransport.history(owner, position) { path, method, body ->
                assertEquals("GET", method); assertNull(body)
                assertEquals("/api/v1/sync/causal-history?epoch=${position.epoch}&revision=0&throughRevision=0&offset=0", path)
                NativeHttpResponse(200, parts.first().toString())
            }
            store.accept(owner, position, fetched)
            val retained = database.causalAccountDao().get(owner)!!
            val resumed = NativeCausalHistoryStore(database)
            val next = resumed.next(owner)!!
            assertEquals(NativeCausalHistoryProtocol.CHUNK_BYTES, next.offset)
            database.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_history_commit BEFORE UPDATE ON causal_accounts BEGIN SELECT RAISE(ABORT,'synthetic history commit failure'); END")
            assertTrue(runCatching { resumed.accept(owner, next, parts[1]) }.isFailure)
            assertEquals(retained, database.causalAccountDao().get(owner))
            assertEquals(next, resumed.next(owner))
            database.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_history_commit")
            for (part in parts.drop(1)) resumed.accept(owner, resumed.next(owner)!!, part)
            assertNull(resumed.next(owner))
            val complete = database.causalAccountDao().get(owner)!!
            val history = NativeCausalJournal.validate(complete).getJSONObject("causalHistory")
            assertEquals(0, history.getInt("downloadedRevision"))
            assertEquals(entry.toString(), history.getJSONObject("entries").getJSONObject("0").getString("body"))
            assertEquals(mirror, database.rawCollectionDao().get("tracking"))
            assertEquals(outbox, database.syncOutboxDao().getAll()); assertEquals(meta, database.syncMetaDao().getAll())
            val envelope = repository.exportBackup("fixture history password")
            assertEquals(listOf(complete), GoalflowBackup.decrypt(envelope, "fixture history password").causalAccounts)
            val damaged = JSONObject(complete.payload)
            damaged.getJSONObject("causalHistory").getJSONObject("entries").remove("0")
            assertTrue(runCatching { NativeCausalJournal.validate(complete.copy(payload = damaged.toString())) }.isFailure)
        } finally { database.close() }
    }
    private fun chunks(owner: String, position: NativeCausalHistoryPosition, body: String): List<JSONObject> {
        val bytes = body.toByteArray(Charsets.UTF_8)
        return (bytes.indices step NativeCausalHistoryProtocol.CHUNK_BYTES).map { offset ->
            val part = bytes.copyOfRange(offset, minOf(bytes.size, offset + NativeCausalHistoryProtocol.CHUNK_BYTES))
            JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", position.epoch)
                .put("revision", position.revision).put("throughRevision", position.throughRevision).put("offset", offset)
                .put("totalBytes", bytes.size).put("sha256", NativeCausalHistoryProtocol.hash(bytes))
                .put("chunkSha256", NativeCausalHistoryProtocol.hash(part)).put("data", Base64.getEncoder().encodeToString(part))
                .put("nextOffset", (offset + part.size).takeIf { it < bytes.size } ?: JSONObject.NULL)
        }
    }

    @Test fun `all shared action kinds assemble exactly with multibyte unknown evidence`() {
        val fixture = fixture(); val owner = fixture.getString("accountId"); val cases = fixture.getJSONArray("cases")
        for (index in 0 until cases.length()) {
            val receipt = cases.getJSONObject(index).getJSONObject("receipt")
            val position = NativeCausalHistoryPosition(receipt.getString("epoch"), 1, 1001)
            val entry = JSONObject().put("schemaVersion", 2).put("accountId", owner).put("epoch", position.epoch)
                .put("revision", 1).put("receipt", receipt).put("unknown", "界😀".repeat(20_000))
            val body = entry.toString(); val parts = chunks(owner, position, body)
            assertTrue(parts.size > 1)
            assertEquals(body, NativeCausalHistoryProtocol.assemble(owner, position, parts))
            assertTrue(runCatching { NativeCausalHistoryProtocol.assemble(owner, position, parts.dropLast(1)) }.isFailure)
            assertTrue(runCatching { NativeCausalHistoryProtocol.assemble(owner, position, parts.reversed()) }.isFailure)
            assertTrue(runCatching { NativeCausalHistoryProtocol.assemble(owner, position.copy(throughRevision = 1002), parts) }.isFailure)
            val damaged = parts.map { JSONObject(it.toString()) }
            damaged[0].put("chunkSha256", "0".repeat(64))
            assertTrue(runCatching { NativeCausalHistoryProtocol.assemble(owner, position, damaged) }.isFailure)
        }
    }
}
