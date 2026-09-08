package com.mariusschober.goalflow.nativeapp.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow

/** Private daily-order authority, independent of optional causal enrollment. */
@Entity(tableName = "planning_accounts")
data class PlanningAccountEntity(@PrimaryKey val accountId: String, val generation: Long, val payload: String)

@Dao
interface PlanningAccountDao {
    @Query("SELECT COALESCE(SUM(generation), 0) FROM planning_accounts")
    fun observeChanges(): Flow<Long>
    @Query("SELECT generation FROM planning_accounts WHERE accountId = :accountId")
    fun observeGeneration(accountId: String): Flow<Long?>
    @Query("SELECT generation FROM planning_accounts WHERE accountId = :accountId")
    suspend fun generation(accountId: String): Long?
    @Query("SELECT length(payload) FROM planning_accounts WHERE accountId = :accountId")
    suspend fun payloadLength(accountId: String): Long?
    @Query("SELECT substr(payload, :start, :count) FROM planning_accounts WHERE accountId = :accountId")
    suspend fun payloadChunk(accountId: String, start: Long, count: Int): String?
    @Query("SELECT accountId FROM planning_accounts ORDER BY accountId")
    suspend fun accountIds(): List<String>
    @Transaction
    suspend fun get(accountId: String): PlanningAccountEntity? {
        val generation = generation(accountId) ?: return null
        val length = payloadLength(accountId) ?: error("Planning journal is missing.")
        val payload = StringBuilder(); var start = 1L
        while (start <= length) {
            val chunk = payloadChunk(accountId, start, 65536) ?: error("Planning journal changed during read.")
            check(chunk.isNotEmpty()); payload.append(chunk)
            start += chunk.codePointCount(0, chunk.length)
        }
        return PlanningAccountEntity(accountId, generation, payload.toString())
    }
    @Transaction
    suspend fun getAll(): List<PlanningAccountEntity> = accountIds().map { get(it) ?: error("Planning journal disappeared.") }
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(state: PlanningAccountEntity)
}
