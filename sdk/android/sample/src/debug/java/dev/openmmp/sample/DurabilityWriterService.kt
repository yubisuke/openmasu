package dev.openmmp.sample

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.Process
import dev.openmmp.sdk.OpenMmpQueueDatabase
import dev.openmmp.sdk.QueuedEvent
import java.io.File

class DurabilityWriterService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val action = intent?.action ?: return START_NOT_STICKY
    Thread({ runProbe(action) }, "openmmp-durability-writer").start()
    return START_NOT_STICKY
  }

  private fun runProbe(action: String) {
    val database = OpenMmpQueueDatabase.open(this)
    val marker = markerFile()
    marker.delete()
    if (action == ACTION_SEED) {
      database.runInTransaction { repeat(1_000) { database.queue().insert(event(it)) } }
      database.close()
      marker.writeText(Process.myPid().toString())
      Thread.sleep(60_000)
      return
    }
    if (action == ACTION_REWRITE_DURING_KILL) {
      database.runInTransaction {
        repeat(1_000) { index ->
          database.queue().insert(event(index))
          if (index == 100) marker.writeText(Process.myPid().toString())
          if (index >= 100) Thread.sleep(2)
        }
      }
      database.close()
    }
  }

  private fun event(index: Int) = QueuedEvent(
    eventId = "event:durability-$index",
    eventName = "custom_event",
    processingPurposeId = "analytics",
    payloadJson = "{\"event_name\":\"custom_event\",\"installation_id\":\"installation:synthetic\",\"event_key\":\"durability\"}",
    occurredAt = "2026-08-20T00:00:00.000Z",
    processingSequence = index.toLong(),
    createdAtEpochMs = index.toLong(),
  )

  private fun markerFile(): File = File(filesDir, "openmmp/durability-ready").apply { parentFile?.mkdirs() }

  companion object {
    const val ACTION_SEED = "dev.openmmp.sample.SEED_QUEUE"
    const val ACTION_REWRITE_DURING_KILL = "dev.openmmp.sample.REWRITE_QUEUE"
  }
}
