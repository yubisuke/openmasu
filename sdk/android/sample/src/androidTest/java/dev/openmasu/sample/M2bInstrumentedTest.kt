package dev.openmasu.sample

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Process
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.openmasu.sdk.InstallationCredential
import dev.openmasu.sdk.MetaReferrerEvidence
import dev.openmasu.sdk.MetaReferrerReader
import dev.openmasu.sdk.OpenMasuConfiguration
import dev.openmasu.sdk.OpenMasuQueueDatabase
import dev.openmasu.sdk.OpenMasuSdk
import dev.openmasu.sdk.PlayReferrerEvidence
import dev.openmasu.sdk.PlayReferrerReader
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class M2bInstrumentedTest {
  private lateinit var context: Context

  @Before fun cleanState() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences("openmasu_private", Context.MODE_PRIVATE).edit().clear().commit()
    File(context.filesDir, "openmasu").deleteRecursively()
  }

  @Test fun emulatorSmokeDeliversOneInstallThroughTheSignedHttpPath() {
    LocalSdkApi().use { api ->
      val sdk = OpenMasuSdk.create(
        context,
        OpenMasuConfiguration(api.endpoint, "sdk-key:synthetic", "synthetic-sdk-secret"),
        playReader = PlayReferrerReader {
          PlayReferrerEvidence(
            status = "available",
            clientResponse = "ok",
            clickId = "abcdefghijklmnopqrstuv",
            referrer = "omv=1&cid=abcdefghijklmnopqrstuv",
            referrerClickAtServer = "2026-08-20T00:00:00.000Z",
            installBeginAtServer = "2026-08-20T00:00:01.000Z",
          )
        },
        metaReader = MetaReferrerReader { MetaReferrerEvidence("provider_unavailable") },
      )
      sdk.initialize()
      assertTrue(api.batchReceived.await(10, TimeUnit.SECONDS))
      val records = JSONObject(api.batchBody).getJSONArray("records")
      assertEquals(1, records.length())
      assertEquals("install", records.getJSONObject(0).getString("event_name"))
      assertEquals(1, api.installBatchCount)
      assertTrue(sdk.flushBlocking())
      assertEquals(setOf("openmasu"), context.filesDir.list()?.toSet().orEmpty())
      sdk.close()
    }
  }

  @Test fun queueSurvivesProcessDeathAndAnInterruptedDuplicateWrite() {
    // This proves committed SQLite state survives process death. It deliberately
    // does not claim survival of abrupt power loss or a kernel panic (M2-D-17).
    startWriter(DurabilityWriterService.ACTION_SEED)
    val seedPid = awaitMarkerPid()
    Process.killProcess(seedPid)
    awaitProcessDeath(seedPid)
    assertQueueCount(1_000)

    marker().delete()
    startWriter(DurabilityWriterService.ACTION_REWRITE_DURING_KILL)
    val rewritePid = awaitMarkerPid()
    Process.killProcess(rewritePid)
    awaitProcessDeath(rewritePid)
    assertQueueCount(1_000)
  }

  private fun startWriter(action: String) {
    val intent = Intent().setComponent(ComponentName(context, DurabilityWriterService::class.java)).setAction(action)
    context.startService(intent)
  }

  private fun marker() = File(context.filesDir, "openmasu/durability-ready")

  private fun awaitMarkerPid(): Int {
    repeat(400) {
      val value = marker().takeIf(File::isFile)?.readText()?.trim()?.toIntOrNull()
      if (value != null) return value
      Thread.sleep(25)
    }
    error("durability_service_did_not_become_ready")
  }

  private fun awaitProcessDeath(pid: Int) {
    repeat(200) {
      if (!File("/proc/$pid").exists()) return
      Thread.sleep(25)
    }
    error("durability_process_did_not_exit")
  }

  private fun assertQueueCount(expected: Int) {
    val database = OpenMasuQueueDatabase.open(context)
    assertEquals(expected, database.queue().count())
    assertEquals(expected, database.queue().pending(2_000).map { it.eventId }.toSet().size)
    database.close()
  }

  private class LocalSdkApi : AutoCloseable {
    private val server = ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"))
    private val thread = Thread(::serve, "openmasu-local-api")
    val endpoint = "http://127.0.0.1:${server.localPort}"
    val batchReceived = CountDownLatch(1)
    @Volatile var batchBody = ""
    @Volatile var installBatchCount = 0

    init { thread.start() }

    private fun serve() {
      repeat(2) {
        server.accept().use { socket ->
          val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
          val request = reader.readLine()
          var contentLength = 0
          while (true) {
            val line = reader.readLine()
            if (line.isNullOrEmpty()) break
            if (line.startsWith("Content-Length:", ignoreCase = true)) contentLength = line.substringAfter(':').trim().toInt()
          }
          val body = CharArray(contentLength)
          var read = 0
          while (read < contentLength) read += reader.read(body, read, contentLength - read)
          val path = request.split(' ')[1]
          val response = if (path == "/v1/installations") {
            "{\"installation_key_id\":\"installation-key:synthetic\",\"installation_secret\":\"installation-secret-synthetic\"}"
          } else {
            batchBody = String(body)
            installBatchCount++
            batchReceived.countDown()
            "{\"status\":\"pending\"}"
          }
          val status = if (path == "/v1/installations") "201 Created" else "202 Accepted"
          val bytes = response.toByteArray(Charsets.UTF_8)
          socket.getOutputStream().write("HTTP/1.1 $status\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
          socket.getOutputStream().write(bytes)
          socket.getOutputStream().flush()
        }
      }
    }

    override fun close() { runCatching { server.close() }; thread.join(2_000) }
  }
}
