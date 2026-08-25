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

@Dao
interface QueueDao {
  @Insert(onConflict = OnConflictStrategy.IGNORE)
  fun insert(event: QueuedEvent): Long

  @Query("SELECT * FROM queued_events ORDER BY processingSequence, eventId LIMIT :limit")
  fun pending(limit: Int): List<QueuedEvent>

  @Query("SELECT COUNT(*) FROM queued_events")
  fun count(): Int

  @Query("DELETE FROM queued_events WHERE eventId IN (:eventIds)")
  fun deleteByIds(eventIds: List<String>)

  @Query("DELETE FROM queued_events WHERE processingPurposeId IN (:purposes)")
  fun deleteByPurposes(purposes: List<String>): Int

  @Query("DELETE FROM queued_events")
  fun deleteAll(): Int
}

@Database(entities = [QueuedEvent::class], version = 1, exportSchema = true)
abstract class OpenMasuQueueDatabase : RoomDatabase() {
  abstract fun queue(): QueueDao

  companion object {
    fun open(context: Context): OpenMasuQueueDatabase {
      val subtree = File(context.filesDir, OpenMasuStorage.SUBTREE).apply { mkdirs() }
      return Room.databaseBuilder(
        context.applicationContext,
        OpenMasuQueueDatabase::class.java,
        File(subtree, "queue.db").absolutePath,
      ).setJournalMode(JournalMode.AUTOMATIC).build()
    }
  }
}
