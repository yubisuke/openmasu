package dev.openmasu.sdk

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import java.io.File

@Entity(tableName = "queued_events", primaryKeys = ["eventId"])
data class QueuedEvent(
  val eventId: String,
  val eventName: String,
  val processingPurposeId: String,
  val payloadJson: String,
  val occurredAt: String,
  val processingSequence: Long,
  val createdAtEpochMs: Long,
)

data class QueueAdmissionResult(val admitted: Boolean, val evicted: Int, val rejected: Int)

data class OpenMasuQueueHealth(
  val pendingCount: Int,
  val logicalBytes: Long,
  val evictedTotal: Long,
  val rejectedTotal: Long,
)

@Entity(tableName = "queue_stats")
data class QueueStats(
  @androidx.room.PrimaryKey val id: Int = 1,
  val evictedTotal: Long = 0,
  val rejectedTotal: Long = 0,
)

object OpenMasuQueueDefaults {
  const val MAX_RECORDS = 10_000
  const val MAX_BYTES = 16L * 1024L * 1024L
}

internal fun QueuedEvent.logicalQueueBytes(): Long =
  eventId.toByteArray(Charsets.UTF_8).size.toLong() +
    eventName.toByteArray(Charsets.UTF_8).size +
    processingPurposeId.toByteArray(Charsets.UTF_8).size +
    payloadJson.toByteArray(Charsets.UTF_8).size +
    occurredAt.toByteArray(Charsets.UTF_8).size +
    16L

internal fun QueuedEvent.queuePriority(): Int = when {
  eventName == "consent_changed" -> 3
  processingPurposeId == "revenue_measurement" || eventName == "install" -> 2
  processingPurposeId == "analytics" -> 0
  else -> 1
}

@Dao
abstract class QueueDao {
  @Insert(onConflict = OnConflictStrategy.IGNORE)
  abstract fun insert(event: QueuedEvent): Long

  @Query("SELECT * FROM queued_events WHERE eventId = :eventId LIMIT 1")
  abstract fun byEventId(eventId: String): QueuedEvent?

  @Query("SELECT * FROM queued_events ORDER BY processingSequence, eventId LIMIT :limit")
  abstract fun pending(limit: Int): List<QueuedEvent>

  @Query("SELECT COUNT(*) FROM queued_events")
  abstract fun count(): Int

  @Query("SELECT * FROM queue_stats WHERE id = 1")
  abstract fun stats(): QueueStats?

  @Query("""
    INSERT INTO queue_stats(id, evictedTotal, rejectedTotal) VALUES (1, :evicted, :rejected)
    ON CONFLICT(id) DO UPDATE SET
      evictedTotal = evictedTotal + excluded.evictedTotal,
      rejectedTotal = rejectedTotal + excluded.rejectedTotal
  """)
  abstract fun incrementStats(evicted: Long, rejected: Long)

  @Query("""
    SELECT COALESCE(SUM(
      length(CAST(eventId AS BLOB)) + length(CAST(eventName AS BLOB)) +
      length(CAST(processingPurposeId AS BLOB)) + length(CAST(payloadJson AS BLOB)) +
      length(CAST(occurredAt AS BLOB)) + 16
    ), 0) FROM queued_events
  """)
  abstract fun logicalBytes(): Long

  @Query("""
    SELECT * FROM queued_events
    WHERE :incomingPriority = 3 OR
      (:incomingPriority = 0 AND CASE
        WHEN eventName = 'consent_changed' THEN 3
        WHEN processingPurposeId = 'revenue_measurement' OR eventName = 'install' THEN 2
        WHEN processingPurposeId = 'analytics' THEN 0
        ELSE 1
      END = 0) OR
      (:incomingPriority > 0 AND CASE
        WHEN eventName = 'consent_changed' THEN 3
        WHEN processingPurposeId = 'revenue_measurement' OR eventName = 'install' THEN 2
        WHEN processingPurposeId = 'analytics' THEN 0
        ELSE 1
      END < :incomingPriority)
    ORDER BY
      CASE
        WHEN eventName = 'consent_changed' THEN 3
        WHEN processingPurposeId = 'revenue_measurement' OR eventName = 'install' THEN 2
        WHEN processingPurposeId = 'analytics' THEN 0
        ELSE 1
      END,
      processingSequence,
      eventId
  """)
  abstract fun evictionCandidates(incomingPriority: Int): List<QueuedEvent>

  @Query("DELETE FROM queued_events WHERE eventId IN (:eventIds)")
  abstract fun deleteByIds(eventIds: List<String>)

  @Query("DELETE FROM queued_events WHERE processingPurposeId IN (:purposes)")
  abstract fun deleteByPurposes(purposes: List<String>): Int

  @Query("DELETE FROM queued_events")
  abstract fun deleteAll(): Int

  @Transaction
  open fun admit(event: QueuedEvent, maxRecords: Int, maxBytes: Long): QueueAdmissionResult {
    require(maxRecords > 0 && maxBytes > 0)
    if (byEventId(event.eventId) != null) return QueueAdmissionResult(admitted = true, evicted = 0, rejected = 0)
    val incomingBytes = event.logicalQueueBytes()
    if (incomingBytes > maxBytes) {
      incrementStats(evicted = 0, rejected = 1)
      return QueueAdmissionResult(admitted = false, evicted = 0, rejected = 1)
    }

    val currentCount = count()
    val currentBytes = logicalBytes()
    if (currentCount < maxRecords && currentBytes + incomingBytes <= maxBytes) {
      val inserted = insert(event) != -1L
      check(inserted) { "queue_insert_conflict" }
      return QueueAdmissionResult(admitted = true, evicted = 0, rejected = 0)
    }

    val victims = mutableListOf<QueuedEvent>()
    var remainingCount = currentCount
    var remainingBytes = currentBytes
    for (candidate in evictionCandidates(event.queuePriority())) {
      victims += candidate
      remainingCount -= 1
      remainingBytes -= candidate.logicalQueueBytes()
      if (remainingCount < maxRecords && remainingBytes + incomingBytes <= maxBytes) break
    }
    if (remainingCount >= maxRecords || remainingBytes + incomingBytes > maxBytes) {
      incrementStats(evicted = 0, rejected = 1)
      return QueueAdmissionResult(admitted = false, evicted = 0, rejected = 1)
    }

    if (victims.isNotEmpty()) deleteByIds(victims.map { it.eventId })
    val inserted = insert(event) != -1L
    check(inserted) { "queue_insert_conflict" }
    incrementStats(evicted = victims.size.toLong(), rejected = 0)
    return QueueAdmissionResult(admitted = true, evicted = victims.size, rejected = 0)
  }
}

@Database(entities = [QueuedEvent::class, QueueStats::class], version = 2, exportSchema = true)
abstract class OpenMasuQueueDatabase : RoomDatabase() {
  abstract fun queue(): QueueDao

  companion object {
    fun open(context: Context): OpenMasuQueueDatabase {
      val subtree = File(context.filesDir, OpenMasuStorage.SUBTREE).apply { mkdirs() }
      return Room.databaseBuilder(
        context.applicationContext,
        OpenMasuQueueDatabase::class.java,
        File(subtree, "queue.db").absolutePath,
      ).setJournalMode(JournalMode.AUTOMATIC)
        .addMigrations(MIGRATION_1_2)
        .build()
    }

    private val MIGRATION_1_2 = object : Migration(1, 2) {
      override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("""
          CREATE TABLE IF NOT EXISTS `queue_stats` (
            `id` INTEGER NOT NULL,
            `evictedTotal` INTEGER NOT NULL,
            `rejectedTotal` INTEGER NOT NULL,
            PRIMARY KEY(`id`)
          )
        """.trimIndent())
      }
    }
  }
}
