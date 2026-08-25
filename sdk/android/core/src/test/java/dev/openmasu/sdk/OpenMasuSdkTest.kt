package dev.openmasu.sdk

import android.content.Context
import android.content.Intent
import android.net.Uri
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
import java.util.concurrent.atomic.AtomicReference

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

  @Test fun `commerce helpers emit scoped non revealing idempotent revenue events`() {
    val sdk = sdk(RecordingTransport(false))
    val transactionId = "transaction:synthetic-49"
    sdk.trackPurchase(transactionId, "1250", 2, "USD")
    sdk.trackPurchase(transactionId, "1250", 2, "USD")
    sdk.trackPurchase(transactionId, "1251", 2, "USD")
    sdk.trackRefund(transactionId, transactionId, "1250", 2, "USD")
    await { sdk.pendingEvents().count { it.eventName == "purchase" || it.eventName == "refund" } == 3 }

    val commerce = sdk.pendingEvents().filter { it.eventName == "purchase" || it.eventName == "refund" }
    assertEquals(setOf("revenue_measurement"), commerce.map { it.processingPurposeId }.toSet())
    assertTrue(commerce.none { it.eventId.contains(transactionId) })
    assertEquals(3, commerce.map { it.eventId }.toSet().size)
    assertTrue(commerce.all { JSONObject(it.payloadJson).getString("financial_status") == "settled" })
    assertTrue(commerce.all { JSONObject(it.payloadJson).getString("installation_id") == sdk.installationId() })

    val purchase = commerce.single {
      it.eventName == "purchase" && JSONObject(it.payloadJson).getString("financial_status") == "settled" &&
        JSONObject(it.payloadJson).getString("transaction_id") == transactionId &&
        JSONObject(it.payloadJson).getString("amount_unscaled") == "1250"
    }
    assertEquals(
      EventFactory.commerceEventId(
        "purchase", sdk.installationId(), transactionId, null, "1250", 2, "USD",
      ),
      purchase.eventId,
    )
    assertEquals(
      "event:commerce:74aaf116d61cb4d92cd254eba0a3ef096d6f877182952d450dd9f89e9aab6cff",
      EventFactory.commerceEventId(
        "purchase", "installation:synthetic-49", transactionId, null, "1250", 2, "USD",
      ),
    )
    val vector = EventFactory.commerceEventId(
      "purchase", "installation:synthetic-49", transactionId, null, "1250", 2, "USD",
    )
    val fieldChanges = listOf(
      EventFactory.commerceEventId("refund", "installation:synthetic-49", transactionId, null, "1250", 2, "USD"),
      EventFactory.commerceEventId("purchase", "installation:other-49", transactionId, null, "1250", 2, "USD"),
      EventFactory.commerceEventId("purchase", "installation:synthetic-49", "transaction:other-49", null, "1250", 2, "USD"),
      EventFactory.commerceEventId("purchase", "installation:synthetic-49", transactionId, "transaction:original-49", "1250", 2, "USD"),
      EventFactory.commerceEventId("purchase", "installation:synthetic-49", transactionId, null, "1251", 2, "USD"),
      EventFactory.commerceEventId("purchase", "installation:synthetic-49", transactionId, null, "1250", 3, "USD"),
      EventFactory.commerceEventId("purchase", "installation:synthetic-49", transactionId, null, "1250", 2, "JPY"),
    )
    assertTrue(fieldChanges.all { it != vector })
    val purchasePayload = JSONObject(purchase.payloadJson)
    assertEquals(sdk.installationId(), purchasePayload.getString("installation_id"))
    assertEquals("1250", purchasePayload.getString("amount_unscaled"))
    assertEquals(2, purchasePayload.getInt("amount_scale"))

    val refundPayload = JSONObject(commerce.single { it.eventName == "refund" }.payloadJson)
    assertEquals(transactionId, refundPayload.getString("original_transaction_id"))
    assertEquals("settled", refundPayload.getString("financial_status"))
    assertTrue(refundPayload.has("installation_id"))
    assertNotEquals(
      purchase.eventId,
      commerce.single {
        it.eventName == "purchase" && JSONObject(it.payloadJson).getString("amount_unscaled") == "1251"
      }.eventId,
    )
  }

  @Test fun `commerce helpers reject negative and malformed money before enqueue`() {
    val sdk = sdk(RecordingTransport(false))
    assertTrue(runCatching { sdk.trackPurchase("transaction:negative-49", "-1", 2, "USD") }.isFailure)
    assertTrue(runCatching { sdk.trackRefund("refund:negative-49", "transaction:negative-49", "-1", 2, "USD") }.isFailure)
    assertTrue(runCatching { sdk.trackPurchase("transaction:scale-49", "1", 19, "USD") }.isFailure)
    assertTrue(runCatching { sdk.trackPurchase("transaction:currency-49", "1", 0, "usd") }.isFailure)
    assertEquals(0, sdk.pendingCount())
  }

  @Test fun `Google Play product purchases remain pending until server verification`() {
    val sdk = sdk(RecordingTransport(false))
    sdk.trackGooglePlayProductPurchase(
      "synthetic-purchase-token-51", "product.synthetic.51", "transaction:synthetic-51",
      "1250", 2, "USD",
    )
    await { sdk.pendingEvents().any { it.eventName == "purchase" } }
    val event = sdk.pendingEvents().single { it.eventName == "purchase" }
    val payload = JSONObject(event.payloadJson)
    assertEquals("pending", payload.getString("financial_status"))
    assertEquals("synthetic-purchase-token-51",
      payload.getJSONObject("extensions").getString("google_play_purchase_token_protected"))
    assertEquals("product.synthetic.51",
      payload.getJSONObject("extensions").getString("google_play_product_id_protected"))
    assertTrue(event.eventId.startsWith("event:commerce:"))
    assertTrue(runCatching {
      sdk.trackGooglePlayProductPurchase("", "product.synthetic.51", "transaction:bad-token", "1", 0, "USD")
    }.isFailure)
    assertTrue(runCatching {
      sdk.trackGooglePlayProductPurchase("synthetic-token", "bad product", "transaction:bad-product", "1", 0, "USD")
    }.isFailure)
  }

  @Test fun `Google Play initial subscriptions remain pending with protected evidence`() {
    val sdk = sdk(RecordingTransport(false))
    sdk.trackGooglePlaySubscriptionPurchase(
      "synthetic-subscription-token-55", "subscription.synthetic.55", "transaction:subscription-55",
      "9999", 2, "USD",
    )
    await { sdk.pendingEvents().any { it.eventName == "purchase" } }
    val event = sdk.pendingEvents().single { it.eventName == "purchase" }
    val payload = JSONObject(event.payloadJson)
    val extensions = payload.getJSONObject("extensions")
    assertEquals("pending", payload.getString("financial_status"))
    assertEquals("synthetic-subscription-token-55",
      extensions.getString("google_play_purchase_token_protected"))
    assertEquals("subscription.synthetic.55", extensions.getString("google_play_product_id_protected"))
    assertEquals("subscription_initial", extensions.getString("google_play_purchase_kind"))
    assertTrue(event.eventId.startsWith("event:commerce:"))
  }

  @Test fun `DL-A-17 and DL-A-18 route a verified app link synchronously before queue delivery`() {
    val transport = RecordingTransport(false)
    val sdk = sdk(transport, configuration = OpenMasuConfiguration(
      "http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret",
      deepLinkHosts = setOf("links.synthetic.invalid"),
      deepLinkSchemes = setOf("openmasu-synthetic"),
    ))
    sdk.initialize()
    val caller = Thread.currentThread()
    val callbackThread = AtomicReference<Thread>()
    val delivered = AtomicReference<OpenMasuDeepLink>()
    sdk.setDeepLinkListener { value -> callbackThread.set(Thread.currentThread()); delivered.set(value) }
    val handled = sdk.handleDeepLink(Intent(Intent.ACTION_VIEW,
      Uri.parse("https://links.synthetic.invalid/r/Synthetic123/shop/item/53?dlp_code=abc&next=https://invalid")))
    assertTrue(handled)
    assertEquals(caller, callbackThread.get())
    assertEquals("/shop/item/53", delivered.get().value)
    assertEquals(mapOf("code" to "abc"), delivered.get().parameters)
    await { sdk.pendingEvents().any { it.eventName == "deep_link_open" } }
    assertTrue(sdk.handleDeepLink(Intent(Intent.ACTION_VIEW,
      Uri.parse("https://links.synthetic.invalid/r/Synthetic123/rejected/bad!suffix"))))
    assertEquals(null, delivered.get().value)
    assertEquals("rejected", delivered.get().destinationStatus)
    assertTrue(sdk.handleDeepLink(Intent(Intent.ACTION_VIEW,
      Uri.parse("openmasu-synthetic://links.synthetic.invalid/r/Synthetic123/custom"))))
    assertEquals("custom_scheme", delivered.get().openSource)
    assertEquals("/custom", delivered.get().value)
    assertFalse(sdk.handleDeepLink(Intent(Intent.ACTION_VIEW,
      Uri.parse("https://unconfigured.invalid/r/Synthetic123/shop"))))
  }

  @Test fun `DL-A-21 keeps listener routing available while collection is disabled`() {
    val transport = RecordingTransport(true)
    val sdk = sdk(transport, configuration = OpenMasuConfiguration(
      "http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret",
      deepLinkHosts = setOf("links.synthetic.invalid"),
    ))
    sdk.setCollectionEnabled(false)
    val calls = AtomicInteger()
    sdk.setDeepLinkListener { calls.incrementAndGet() }
    assertTrue(sdk.handleDeepLink(Intent(Intent.ACTION_VIEW,
      Uri.parse("https://links.synthetic.invalid/r/Synthetic123/direct"))))
    assertEquals(1, calls.get())
    assertEquals(0, transport.calls.get())
    assertEquals(0, sdk.pendingCount())
  }

  @Test fun `DL-A-22 delivers a fresh deferred destination once and rejects an expired one`() {
    val freshCalls = AtomicInteger()
    val fresh = sdk(RecordingTransport(false), PlayReferrerReader {
      PlayReferrerEvidence(
        status = "available", clientResponse = "ok", clickId = "click-53_0000000000000000",
        referrerClickAtServer = EventFactory.canonicalNow(), deepLinkValue = "/deferred/53",
        deepLinkParameters = mapOf("code" to "abc"), deferredDeepLinkStatus = "delivered",
      )
    })
    fresh.setDeepLinkListener { freshCalls.incrementAndGet() }
    fresh.initialize()
    await { fresh.pendingEvents().any { it.eventName == "deep_link_open" } }
    assertEquals(1, freshCalls.get())
    assertTrue(fresh.pendingEvents().single { it.eventName == "install" }.payloadJson.contains("\"deferred_deep_link_status\":\"delivered\""))

    fresh.close()
    created.remove(fresh)
    context.getSharedPreferences(OpenMasuStorage.PREFERENCES, Context.MODE_PRIVATE).edit().clear().commit()
    context.filesDir.resolve(OpenMasuStorage.SUBTREE).deleteRecursively()
    val expiredCalls = AtomicInteger()
    val expired = sdk(RecordingTransport(false), PlayReferrerReader {
      PlayReferrerEvidence(
        status = "available", clientResponse = "ok", clickId = "click-53_0000000000000000",
        referrerClickAtServer = "2020-01-01T00:00:00.000Z", deepLinkValue = "/expired/53",
        deferredDeepLinkStatus = "delivered",
      )
    })
    expired.setDeepLinkListener { expiredCalls.incrementAndGet() }
    expired.initialize()
    await { expired.pendingEvents().any { it.eventName == "install" } }
    assertEquals(0, expiredCalls.get())
    assertTrue(expired.pendingEvents().single { it.eventName == "install" }.payloadJson.contains("\"deferred_deep_link_status\":\"expired\""))
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
    configuration: OpenMasuConfiguration = OpenMasuConfiguration("http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret"),
  ): OpenMasuSdk = OpenMasuSdk.create(
    context,
    configuration,
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
