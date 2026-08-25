package dev.openmasu.sdk

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class OpenMasuSdkTest {
  private lateinit var context: Context
  private val created = mutableListOf<OpenMasuSdk>()

  @Before fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences(OpenMasuStorage.PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit()
    context.filesDir.resolve(OpenMasuStorage.SUBTREE).deleteRecursively()
  }

  @After fun tearDown() { created.forEach { it.close() } }

  @Test fun `disabled before initialize performs no reads or network calls`() {
    val transport = RecordingTransport(true)
    val playReads = AtomicInteger()
    val metaReads = AtomicInteger()
    val sdk = sdk(
      transport,
      PlayReferrerReader { playReads.incrementAndGet(); PlayReferrerEvidence("none", "ok") },
      MetaReferrerReader { metaReads.incrementAndGet(); MetaReferrerEvidence("provider_unavailable") },
    )
    sdk.setCollectionEnabled(false)
    sdk.initialize()
    Thread.sleep(150)
    assertEquals(0, transport.calls.get())
    assertEquals(0, playReads.get())
    assertEquals(0, metaReads.get())
    assertEquals(0, sdk.pendingCount())
  }

  @Test fun `withdrawal atomically purges consent-required purposes and keeps the control event`() {
    val transport = RecordingTransport(false)
    val sdk = sdk(transport)
    sdk.initialize()
    await { sdk.pendingEvents().any { it.processingPurposeId == "attribution" } }
    sdk.trackCustomEvent("tutorial_complete")
    sdk.enqueueAdRevenue(JSONObject()
      .put("event_name", "ad_revenue").put("subject_scope", "installation_level")
      .put("installation_id", sdk.installationId()).put("ad_network", "synthetic")
      .put("amount_unscaled", "1").put("amount_scale", 6).put("currency", "USD")
      .put("revenue_source", "client_estimated").put("revenue_precision", "exact"))
    await { sdk.pendingEvents().map { it.processingPurposeId }.containsAll(listOf("attribution", "analytics", "revenue_measurement")) }
    val fraudDatabase = OpenMasuQueueDatabase.open(context)
    try {
      val database = fraudDatabase
      Thread {
        database.queue().insert(QueuedEvent(
          "event:fraud-control-synthetic", "privacy_control", "fraud_prevention",
          "{\"event_name\":\"privacy_control\"}", EventFactory.canonicalNow(), 9_999, System.currentTimeMillis(),
        ))
      }.apply { start(); join() }
    } finally { fraudDatabase.close() }
    sdk.updateConsent("withdrawn", "synthetic-policy-v1")
    await { sdk.pendingEvents().any { it.eventName == "consent_changed" } }
    val remaining = sdk.pendingEvents()
    assertEquals(setOf("privacy_control", "consent_changed"), remaining.map { it.eventName }.toSet())
    assertEquals(setOf("fraud_prevention"), remaining.map { it.processingPurposeId }.toSet())
  }

  @Test fun `session start uses a durable analytics event`() {
    val sdk = sdk(RecordingTransport(false))
    sdk.initialize()
    sdk.startSession()
    await { sdk.pendingEvents().any { it.eventName == "session_start" } }
    val session = sdk.pendingEvents().single { it.eventName == "session_start" }
    assertEquals("analytics", session.processingPurposeId)
    assertTrue(session.payloadJson.contains("\"installation_id\""))
    assertTrue(session.payloadJson.contains("\"session_id\":\"session:"))
  }

  @Test fun `reset deletes first then creates a fresh anchor without re-reading referrers`() {
    val transport = RecordingTransport(true)
    val reads = AtomicInteger()
    val sdk = sdk(transport, PlayReferrerReader {
      reads.incrementAndGet(); PlayReferrerEvidence("none", "ok")
    })
    sdk.initialize()
    await { transport.deliveries.get() == 1 }
    val oldId = sdk.installationId()
    val complete = CountDownLatch(1)
    var resetResult = false
    sdk.resetInstallationId { resetResult = it; complete.countDown() }
    assertTrue(complete.await(5, TimeUnit.SECONDS))
    assertTrue(resetResult)
    assertNotEquals(oldId, sdk.installationId())
    assertEquals(1, reads.get())
    assertEquals(oldId, transport.deletedInstallation)
    val resetPayload = transport.deliveredPayloads.last().first { it.eventName == "install" }.payloadJson
    assertTrue(resetPayload.contains("\"install_origin\":\"identifier_reset\""))
    assertTrue(resetPayload.contains("\"referrer_status\":\"none\""))
  }

  @Test fun `failed deletion keeps the old installation identity`() {
    val transport = RecordingTransport(true).apply { deletionSucceeds = false }
    val sdk = sdk(transport)
    sdk.initialize()
    await { transport.deliveries.get() == 1 }
    val oldId = sdk.installationId()
    val complete = CountDownLatch(1)
    var resetResult = true
    sdk.resetInstallationId { resetResult = it; complete.countDown() }
    assertTrue(complete.await(5, TimeUnit.SECONDS))
    assertFalse(resetResult)
    assertEquals(oldId, sdk.installationId())
  }

  private fun sdk(
    transport: RecordingTransport,
    playReader: PlayReferrerReader = PlayReferrerReader { PlayReferrerEvidence("none", "ok") },
    metaReader: MetaReferrerReader = MetaReferrerReader { MetaReferrerEvidence("provider_unavailable") },
  ): OpenMasuSdk = OpenMasuSdk.create(
    context,
    OpenMasuConfiguration("http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret"),
    transport,
    playReader,
    metaReader,
    {},
  ).also(created::add)

  private fun await(condition: () -> Boolean) {
    repeat(100) { if (condition()) return; Thread.sleep(25) }
    error("condition_not_met")
  }

  private class RecordingTransport(private val deliverySucceeds: Boolean) : OpenMasuTransport {
    val calls = AtomicInteger()
    val deliveries = AtomicInteger()
    val deliveredPayloads = mutableListOf<List<QueuedEvent>>()
    var deletedInstallation: String? = null
    var deletionSucceeds = true
    override fun enroll(installationId: String): InstallationCredential {
      calls.incrementAndGet()
      return InstallationCredential("installation-key:synthetic", "installation-secret-synthetic")
    }
    override fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean {
      calls.incrementAndGet(); deliveries.incrementAndGet(); deliveredPayloads += events
      return deliverySucceeds
    }
    override fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean {
      calls.incrementAndGet(); deletedInstallation = installationId
      return deletionSucceeds
    }
  }
}
