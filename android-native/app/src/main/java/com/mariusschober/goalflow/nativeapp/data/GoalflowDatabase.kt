package com.mariusschober.goalflow.nativeapp.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Update
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Entity(
    tableName = "tasks",
    indices = [
        Index(value = ["scheduledFor", "schedulePrecision", "status", "deletedAt"]),
        Index(value = ["goalId"]),
        Index(value = ["habitId", "scheduledFor", "deletedAt"])
    ]
)
data class TaskEntity(
    @PrimaryKey val id: String,
    val title: String,
    val notes: String,
    val schedulePrecision: String,
    val scheduledFor: String,
    val scheduledTime: String?,
    val plannedOrder: Int,
    val status: String,
    val isFrog: Boolean,
    val beforeFrog: Boolean,
    val frogFailures: Int,
    val source: String,
    val goalId: String?,
    val parentTaskId: String?,
    val habitId: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val completedAt: Long?,
    val deletedAt: Long?,
    @ColumnInfo(defaultValue = "'{}'") val extraJson: String = "{}"
)

@Entity(tableName = "goals")
data class GoalEntity(
    @PrimaryKey val id: String,
    val name: String,
    val description: String,
    val deadline: String?,
    val completedTasks: Int,
    val color: String,
    val createdAt: Long,
    val excitement: Int?,
    val roi: Int?,
    @ColumnInfo(defaultValue = "'{}'") val extraJson: String = "{}"
)

@Entity(tableName = "daily_plans")
data class DailyPlanEntity(
    @PrimaryKey val localDate: String,
    val confirmedAt: Long,
    val taskIds: String
)

@Entity(tableName = "habits")
data class HabitEntity(
    @PrimaryKey val id: String,
    val title: String,
    val frequency: String,
    val specificDays: String,
    val streak: Int,
    val bestStreak: Int,
    val lastCompletedDate: String?,
    val isHighPriority: Boolean,
    val beforeFrog: Boolean,
    val duration: Int?,
    val goalId: String?,
    val createdAt: Long,
    @ColumnInfo(defaultValue = "'{}'") val extraJson: String = "{}"
)

@Entity(
    tableName = "sync_outbox",
    indices = [
        Index(value = ["entityType", "entityId", "version"]),
        Index(value = ["dependsOnMutationId"])
    ]
)
data class SyncOutboxEntity(
    @PrimaryKey val mutationId: String,
    val deviceId: String,
    val entityType: String,
    val entityId: String,
    val baseServerVersion: Long?,
    val version: Long,
    val payload: String,
    val updatedAt: String,
    val deletedAt: String?,
    val dependsOnMutationId: String? = null,
    val resolvesConflictId: String? = null,
    val attemptedAt: String? = null
)

@Entity(tableName = "sync_meta")
data class SyncMetaEntity(
    @PrimaryKey val entityType: String,
    val cursor: Long,
    val localVersion: Long,
    val serverVersion: Long?,
    val lastSuccessfulSync: String?
)

@Entity(
    tableName = "sync_conflicts",
    indices = [Index(value = ["entityType", "entityId", "status"])]
)
data class SyncConflictEntity(
    @PrimaryKey val id: String,
    val entityType: String,
    @ColumnInfo(defaultValue = "'singleton'") val entityId: String = "singleton",
    val mutationId: String? = null,
    val localPayload: String,
    val localDeletedAt: String? = null,
    @ColumnInfo(defaultValue = "'[]'") val localHistory: String = "[]",
    val serverPayload: String,
    val serverDeletedAt: String? = null,
    val serverVersion: Long,
    val createdAt: String,
    @ColumnInfo(defaultValue = "'unresolved'") val status: String = "unresolved"
)

/** Preserve collections not yet rendered by a dedicated native screen. */
@Entity(tableName = "raw_collections")
data class RawCollectionEntity(
    @PrimaryKey val entityType: String,
    val payload: String,
    val updatedAt: String,
    val deletedAt: String?
)

@Entity(tableName = "local_account")
data class LocalAccountEntity(
    @PrimaryKey val bindingKey: String = "owner",
    val userId: String
)

/** Private causal authority; never an ordinary sync entity. */
@Entity(tableName = "causal_accounts")
data class CausalAccountEntity(
    @PrimaryKey val accountId: String,
    val payload: String
)

@Dao
interface CausalAccountDao {
    @Query("SELECT length(payload) FROM causal_accounts WHERE accountId = :accountId LIMIT 1")
    suspend fun payloadLength(accountId: String): Long?

    @Query("SELECT substr(payload, :start, :count) FROM causal_accounts WHERE accountId = :accountId LIMIT 1")
    suspend fun payloadChunk(accountId: String, start: Long, count: Int): String?

    @Query("SELECT accountId FROM causal_accounts ORDER BY accountId")
    suspend fun accountIds(): List<String>

    /** SQLite substr counts Unicode characters, so each bounded chunk fits a
     * CursorWindow even when the complete durable journal does not. The read
     * transaction prevents mixing revisions across chunks. */
    @androidx.room.Transaction
    suspend fun get(accountId: String): CausalAccountEntity? {
        val length = payloadLength(accountId) ?: return null
        val payload = StringBuilder()
        var start = 1L
        while (start <= length) {
            payload.append(requireNotNull(payloadChunk(accountId, start, 16_384)))
            start += 16_384
        }
        return CausalAccountEntity(accountId, payload.toString())
    }

    @androidx.room.Transaction
    suspend fun getAll(): List<CausalAccountEntity> = accountIds().map { requireNotNull(get(it)) }

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(account: CausalAccountEntity)

    @Update
    suspend fun update(account: CausalAccountEntity): Int
}

@Dao
interface TaskDao {
    @Query("SELECT * FROM tasks ORDER BY scheduledFor ASC, plannedOrder ASC, createdAt ASC, id ASC")
    fun observeAll(): Flow<List<TaskEntity>>

    @Query("SELECT * FROM tasks")
    suspend fun getAll(): List<TaskEntity>

    @Query("SELECT * FROM tasks WHERE id = :id LIMIT 1")
    suspend fun get(id: String): TaskEntity?

    @Query("SELECT COALESCE(MAX(plannedOrder), -1) FROM tasks WHERE scheduledFor = :scheduledFor AND schedulePrecision = :precision")
    suspend fun maxOrder(scheduledFor: String, precision: String): Int

    @Query("SELECT COUNT(*) FROM tasks WHERE scheduledFor = :scheduledFor AND status = 'open' AND deletedAt IS NULL AND schedulePrecision = 'day'")
    suspend fun countRemainingToday(scheduledFor: String): Int

    @Query("SELECT * FROM tasks WHERE scheduledFor = :scheduledFor AND deletedAt IS NULL")
    suspend fun getByScheduledFor(scheduledFor: String): List<TaskEntity>

    @Query("SELECT * FROM tasks WHERE goalId = :goalId AND deletedAt IS NULL")
    suspend fun getByGoalId(goalId: String): List<TaskEntity>

    @Query("SELECT * FROM tasks WHERE habitId = :habitId AND scheduledFor = :scheduledFor AND deletedAt IS NULL LIMIT 1")
    suspend fun getByHabitAndDate(habitId: String, scheduledFor: String): TaskEntity?

    @Query("SELECT * FROM tasks WHERE habitId = :habitId AND deletedAt IS NULL")
    suspend fun getByHabitId(habitId: String): List<TaskEntity>

    @Query("SELECT * FROM tasks WHERE habitId IN (:habitIds) AND scheduledFor = :scheduledFor AND deletedAt IS NULL")
    suspend fun getByHabitIdsAndDate(habitIds: List<String>, scheduledFor: String): List<TaskEntity>

    @Query("SELECT * FROM tasks LIMIT :limit OFFSET :offset")
    suspend fun getAllPaged(limit: Int, offset: Int): List<TaskEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(task: TaskEntity)

    @Update
    suspend fun update(task: TaskEntity)

    @Update
    suspend fun updateAll(tasks: List<TaskEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(tasks: List<TaskEntity>)

    @Query("DELETE FROM tasks")
    suspend fun deleteAll()

    @Query("DELETE FROM tasks WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface GoalDao {
    @Query("SELECT * FROM goals ORDER BY createdAt ASC, id ASC")
    fun observeAll(): Flow<List<GoalEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(goal: GoalEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(goals: List<GoalEntity>)

    @Query("SELECT * FROM goals")
    suspend fun getAll(): List<GoalEntity>

    @Query("SELECT * FROM goals LIMIT :limit OFFSET :offset")
    suspend fun getAllPaged(limit: Int, offset: Int): List<GoalEntity>

    @Query("SELECT * FROM goals WHERE id = :id LIMIT 1")
    suspend fun get(id: String): GoalEntity?

    @Query("DELETE FROM goals")
    suspend fun deleteAll()

    @Query("DELETE FROM goals WHERE id = :id")
    suspend fun delete(id: String)
}

@Dao
interface DailyPlanDao {
    @Query("SELECT * FROM daily_plans WHERE localDate = :localDate LIMIT 1")
    fun observe(localDate: String): Flow<DailyPlanEntity?>

    @Query("SELECT * FROM daily_plans WHERE localDate = :localDate LIMIT 1")
    suspend fun get(localDate: String): DailyPlanEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(plan: DailyPlanEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(plans: List<DailyPlanEntity>)

    @Query("SELECT * FROM daily_plans")
    suspend fun getAll(): List<DailyPlanEntity>

    @Query("SELECT * FROM daily_plans LIMIT :limit OFFSET :offset")
    suspend fun getAllPaged(limit: Int, offset: Int): List<DailyPlanEntity>

    @Query("DELETE FROM daily_plans WHERE localDate = :localDate")
    suspend fun delete(localDate: String)

    @Query("DELETE FROM daily_plans")
    suspend fun deleteAll()
}

@Dao
interface HabitDao {
    @Query("SELECT * FROM habits ORDER BY createdAt ASC, id ASC")
    fun observeAll(): Flow<List<HabitEntity>>

    @Query("SELECT * FROM habits")
    suspend fun getAll(): List<HabitEntity>

    @Query("SELECT * FROM habits LIMIT :limit OFFSET :offset")
    suspend fun getAllPaged(limit: Int, offset: Int): List<HabitEntity>

    @Query("SELECT * FROM habits WHERE id = :id LIMIT 1")
    suspend fun get(id: String): HabitEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(habit: HabitEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(habits: List<HabitEntity>)

    @Query("DELETE FROM habits WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM habits")
    suspend fun deleteAll()
}

@Dao
interface TaskEventDao {
    @Query("SELECT * FROM task_events ORDER BY createdAt ASC, id ASC")
    suspend fun getAll(): List<TaskEventEntity>

    @Query("SELECT * FROM task_events LIMIT :limit OFFSET :offset")
    suspend fun getAllPaged(limit: Int, offset: Int): List<TaskEventEntity>

    @Query("SELECT * FROM task_events WHERE id = :id LIMIT 1")
    suspend fun get(id: String): TaskEventEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(event: TaskEventEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(events: List<TaskEventEntity>)

    @Query("DELETE FROM task_events WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM task_events")
    suspend fun deleteAll()
}

@Dao
interface SyncOutboxDao {
    @Query("SELECT * FROM sync_outbox WHERE mutationId = :mutationId LIMIT 1")
    suspend fun get(mutationId: String): SyncOutboxEntity?

    @Query("SELECT * FROM sync_outbox ORDER BY version ASC, mutationId ASC")
    suspend fun getAll(): List<SyncOutboxEntity>

    @Query("SELECT * FROM sync_outbox WHERE entityType = :entityType AND entityId = :entityId ORDER BY version ASC, mutationId ASC")
    suspend fun getForEntity(entityType: String, entityId: String): List<SyncOutboxEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(mutation: SyncOutboxEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(mutations: List<SyncOutboxEntity>)

    @Query("DELETE FROM sync_outbox WHERE mutationId = :mutationId")
    suspend fun delete(mutationId: String)

    @Query("DELETE FROM sync_outbox WHERE entityType = :entityType AND entityId = :entityId")
    suspend fun deleteForEntity(entityType: String, entityId: String)

    @Query("UPDATE sync_outbox SET attemptedAt = :attemptedAt WHERE mutationId IN (:mutationIds)")
    suspend fun markAttempted(mutationIds: List<String>, attemptedAt: String)

    @Query("DELETE FROM sync_outbox")
    suspend fun deleteAll()
}

@Dao
interface SyncMetaDao {
    @Query("SELECT * FROM sync_meta WHERE entityType = :entityType LIMIT 1")
    suspend fun get(entityType: String): SyncMetaEntity?

    @Query("SELECT * FROM sync_meta")
    suspend fun getAll(): List<SyncMetaEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(meta: SyncMetaEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(meta: List<SyncMetaEntity>)

    @Query("DELETE FROM sync_meta")
    suspend fun deleteAll()
}

@Dao
interface SyncConflictDao {
    @Query("SELECT * FROM sync_conflicts ORDER BY createdAt ASC, id ASC")
    fun observeAll(): Flow<List<SyncConflictEntity>>

    @Query("SELECT * FROM sync_conflicts ORDER BY createdAt ASC, id ASC")
    suspend fun getAll(): List<SyncConflictEntity>

    @Query("SELECT * FROM sync_conflicts WHERE entityType = :entityType AND entityId = :entityId AND status NOT IN ('resolved', 'resolving_local') ORDER BY createdAt ASC LIMIT 1")
    suspend fun getUnresolved(entityType: String, entityId: String): SyncConflictEntity?

    @Query("SELECT * FROM sync_conflicts WHERE id = :id LIMIT 1")
    suspend fun get(id: String): SyncConflictEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(conflict: SyncConflictEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertAll(conflicts: List<SyncConflictEntity>)

    @Update
    suspend fun update(conflict: SyncConflictEntity)

    @Query("DELETE FROM sync_conflicts WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM sync_conflicts")
    suspend fun deleteAll()
}

@Dao
interface RawCollectionDao {
    @Query("SELECT * FROM raw_collections WHERE entityType = :entityType LIMIT 1")
    fun observe(entityType: String): Flow<RawCollectionEntity?>

    @Query("SELECT * FROM raw_collections WHERE entityType = :entityType LIMIT 1")
    suspend fun get(entityType: String): RawCollectionEntity?

    @Query("SELECT * FROM raw_collections")
    suspend fun getAll(): List<RawCollectionEntity>

    @Query("SELECT * FROM raw_collections WHERE entityType LIKE :prefix ORDER BY entityType ASC")
    fun observeByPrefix(prefix: String): Flow<List<RawCollectionEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(collection: RawCollectionEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIfAbsent(collection: RawCollectionEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(collections: List<RawCollectionEntity>)

    @Query("DELETE FROM raw_collections WHERE entityType = :entityType")
    suspend fun delete(entityType: String)

    @Query("DELETE FROM raw_collections")
    suspend fun deleteAll()
}

@Dao
interface LocalAccountDao {
    @Query("SELECT * FROM local_account WHERE bindingKey = 'owner' LIMIT 1")
    suspend fun get(): LocalAccountEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insert(account: LocalAccountEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertAll(accounts: List<LocalAccountEntity>)
}

@Database(
    entities = [
        TaskEntity::class,
        GoalEntity::class,
        DailyPlanEntity::class,
        HabitEntity::class,
        SyncOutboxEntity::class,
        SyncMetaEntity::class,
        SyncConflictEntity::class,
        RawCollectionEntity::class,
        TaskEventEntity::class,
        LocalAccountEntity::class,
        CausalAccountEntity::class
    ],
    version = 9,
    exportSchema = true
)
abstract class GoalflowDatabase : RoomDatabase() {
    abstract fun taskDao(): TaskDao
    abstract fun goalDao(): GoalDao
    abstract fun dailyPlanDao(): DailyPlanDao
    abstract fun habitDao(): HabitDao
    abstract fun syncOutboxDao(): SyncOutboxDao
    abstract fun syncMetaDao(): SyncMetaDao
    abstract fun syncConflictDao(): SyncConflictDao
    abstract fun rawCollectionDao(): RawCollectionDao
    abstract fun taskEventDao(): TaskEventDao
    abstract fun localAccountDao(): LocalAccountDao
    abstract fun causalAccountDao(): CausalAccountDao

    companion object {
        private val integrityCallback = object : RoomDatabase.Callback() {
            override fun onCreate(database: SupportSQLiteDatabase) {
                installActiveHabitDayUniqueness(database)
            }

            override fun onOpen(database: SupportSQLiteDatabase) {
                // Installing on every open closes the invariant for upgraded
                // databases whose original schema predated these triggers.
                installActiveHabitDayUniqueness(database)
            }
        }

        /** Storage-level guard for one non-deleted habit instance per day. */
        internal fun installActiveHabitDayUniqueness(database: SupportSQLiteDatabase) {
            database.execSQL(
                """
                CREATE TRIGGER IF NOT EXISTS goalflow_unique_active_habit_day_insert
                BEFORE INSERT ON tasks
                WHEN NEW.habitId IS NOT NULL
                    AND NEW.scheduledFor IS NOT NULL
                    AND NEW.deletedAt IS NULL
                    AND EXISTS (
                        SELECT 1 FROM tasks
                        WHERE habitId = NEW.habitId
                            AND scheduledFor = NEW.scheduledFor
                            AND deletedAt IS NULL
                    )
                BEGIN
                    SELECT RAISE(ABORT, 'active habit day already exists');
                END
                """.trimIndent()
            )
            database.execSQL(
                """
                CREATE TRIGGER IF NOT EXISTS goalflow_unique_active_habit_day_update
                BEFORE UPDATE OF habitId, scheduledFor, deletedAt ON tasks
                WHEN NEW.habitId IS NOT NULL
                    AND NEW.scheduledFor IS NOT NULL
                    AND NEW.deletedAt IS NULL
                    AND EXISTS (
                        SELECT 1 FROM tasks
                        WHERE id != NEW.id
                            AND habitId = NEW.habitId
                            AND scheduledFor = NEW.scheduledFor
                            AND deletedAt IS NULL
                    )
                BEGIN
                    SELECT RAISE(ABORT, 'active habit day already exists');
                END
                """.trimIndent()
            )
        }

        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS habits (id TEXT NOT NULL PRIMARY KEY, title TEXT NOT NULL, frequency TEXT NOT NULL, specificDays TEXT NOT NULL, streak INTEGER NOT NULL, bestStreak INTEGER NOT NULL, lastCompletedDate TEXT, isHighPriority INTEGER NOT NULL, beforeFrog INTEGER NOT NULL, duration INTEGER, goalId TEXT, createdAt INTEGER NOT NULL)")
                database.execSQL("CREATE TABLE IF NOT EXISTS sync_outbox (mutationId TEXT NOT NULL PRIMARY KEY, deviceId TEXT NOT NULL, entityType TEXT NOT NULL, entityId TEXT NOT NULL, baseServerVersion INTEGER, version INTEGER NOT NULL, payload TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT)")
                database.execSQL("CREATE TABLE IF NOT EXISTS sync_meta (entityType TEXT NOT NULL PRIMARY KEY, cursor INTEGER NOT NULL, localVersion INTEGER NOT NULL, serverVersion INTEGER, lastSuccessfulSync TEXT)")
                database.execSQL("CREATE TABLE IF NOT EXISTS sync_conflicts (id TEXT NOT NULL PRIMARY KEY, entityType TEXT NOT NULL, localPayload TEXT NOT NULL, serverPayload TEXT NOT NULL, serverVersion INTEGER NOT NULL, createdAt TEXT NOT NULL)")
            }
        }

        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE sync_outbox ADD COLUMN dependsOnMutationId TEXT")
                database.execSQL("ALTER TABLE sync_outbox ADD COLUMN resolvesConflictId TEXT")
                database.execSQL("ALTER TABLE sync_outbox ADD COLUMN attemptedAt TEXT")
                database.execSQL("ALTER TABLE sync_conflicts ADD COLUMN entityId TEXT NOT NULL DEFAULT 'singleton'")
                database.execSQL("ALTER TABLE sync_conflicts ADD COLUMN mutationId TEXT")
                database.execSQL("ALTER TABLE sync_conflicts ADD COLUMN localDeletedAt TEXT")
                database.execSQL("ALTER TABLE sync_conflicts ADD COLUMN localHistory TEXT NOT NULL DEFAULT '[]'")
                database.execSQL("ALTER TABLE sync_conflicts ADD COLUMN serverDeletedAt TEXT")
                database.execSQL("ALTER TABLE sync_conflicts ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved'")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_sync_outbox_entityType_entityId_version ON sync_outbox (entityType, entityId, version)")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_sync_conflicts_entityType_entityId_status ON sync_conflicts (entityType, entityId, status)")
            }
        }

        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("ALTER TABLE tasks ADD COLUMN extraJson TEXT NOT NULL DEFAULT '{}'")
                database.execSQL("ALTER TABLE goals ADD COLUMN extraJson TEXT NOT NULL DEFAULT '{}'")
                database.execSQL("ALTER TABLE habits ADD COLUMN extraJson TEXT NOT NULL DEFAULT '{}'")
            }
        }

        private val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS raw_collections (entityType TEXT NOT NULL PRIMARY KEY, payload TEXT NOT NULL, updatedAt TEXT NOT NULL, deletedAt TEXT)")
            }
        }

        private val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS task_events (id TEXT NOT NULL PRIMARY KEY, taskId TEXT NOT NULL, eventType TEXT NOT NULL, localDate TEXT NOT NULL, metadata TEXT NOT NULL, createdAt INTEGER NOT NULL)")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_task_events_taskId_createdAt ON task_events (taskId, createdAt)")
            }
        }

        private val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS local_account (bindingKey TEXT NOT NULL PRIMARY KEY, userId TEXT NOT NULL)")
            }
        }

        private val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE INDEX IF NOT EXISTS index_tasks_scheduledFor_schedulePrecision_status_deletedAt ON tasks(scheduledFor, schedulePrecision, status, deletedAt)")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_tasks_goalId ON tasks(goalId) WHERE goalId IS NOT NULL")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_tasks_habit_scheduledFor_deletedAt ON tasks(habitId, scheduledFor, deletedAt) WHERE habitId IS NOT NULL")
                database.execSQL("CREATE INDEX IF NOT EXISTS index_sync_outbox_dependsOnMutationId ON sync_outbox(dependsOnMutationId) WHERE dependsOnMutationId IS NOT NULL")
            }
        }

        private val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(database: SupportSQLiteDatabase) {
                database.execSQL("CREATE TABLE IF NOT EXISTS causal_accounts (accountId TEXT NOT NULL PRIMARY KEY, payload TEXT NOT NULL)")
            }
        }

        fun migrations(): Array<Migration> = arrayOf(
            MIGRATION_1_2,
            MIGRATION_2_3,
            MIGRATION_3_4,
            MIGRATION_4_5,
            MIGRATION_5_6,
            MIGRATION_6_7,
            MIGRATION_7_8,
            MIGRATION_8_9
        )
        fun create(context: Context): GoalflowDatabase = Room.databaseBuilder(
            context,
            GoalflowDatabase::class.java,
            "goalflow-native.db"
        ).addMigrations(*migrations()).addCallback(integrityCallback).build()

        // Test helper: create database with custom name for migration matrix tests
        fun createForTest(context: Context, name: String): GoalflowDatabase = Room.databaseBuilder(
            context,
            GoalflowDatabase::class.java,
            name
        ).addMigrations(*migrations()).addCallback(integrityCallback).build()
    }
}
