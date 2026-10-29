package dev.openmasu.sdk

import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
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
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
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

  @Test fun `synthetic validation is explicit local bounded and cleared on withdrawal and reset`() {
    val token = "A".repeat(43)
    val transport = SyntheticValidationTransport()
    val sdk = sdk(transport)
    sdk.setCollectionEnabled(false)
    sdk.setSyntheticValidationSession(token, System.currentTimeMillis() + 60_000)
    assertEquals(0, transport.calls.get())
    assertEquals(0, sdk.pendingCount())
    assertFalse(context.getSharedPreferences(OpenMasuStorage.PREFERENCES, Context.MODE_PRIVATE).contains("installation_id"))
    assertFalse(diagnostics(sdk).toString().contains(token))
    sdk.clearSyntheticValidationSession()
    assertEquals(0, transport.calls.get())
    for ((badToken, expiry) in listOf(
      "invalid" to System.currentTimeMillis() + 60_000,
      ("A".repeat(42) + "B") to System.currentTimeMillis() + 60_000,
      token to System.currentTimeMillis() - 1,
      token to System.currentTimeMillis() + 3_600_000,
    )) {
      org.junit.Assert.assertThrows(IllegalArgumentException::class.java) { sdk.setSyntheticValidationSession(badToken, expiry) }
    }
    sdk.setCollectionEnabled(true)
    sdk.startSession(); sdk.pendingCount()
    assertEquals(1, transport.normalCalls.get())
    sdk.setSyntheticValidationSession(token, System.currentTimeMillis() + 60_000)
    sdk.startSession(); sdk.pendingCount()
    assertEquals(listOf(token), transport.tokens.toList())
    sdk.close(); created.remove(sdk)
    val reopened = sdk(transport)
    reopened.startSession(); reopened.pendingCount()
    assertEquals(listOf(token, token), transport.tokens.toList())
    val storage = OpenMasuStorage(context)
    storage.setSyntheticValidationSession(SyntheticValidationSession(token, System.currentTimeMillis() - 1))
    reopened.startSession(); reopened.pendingCount()
    assertEquals(2, transport.normalCalls.get())
    val preferences = context.getSharedPreferences(OpenMasuStorage.PREFERENCES, Context.MODE_PRIVATE)
    assertFalse(preferences.contains("synthetic_validation_session"))
    for (invalid in listOf("not-json", "{\"token\":\"invalid\",\"expires_at_ms\":${System.currentTimeMillis() + 60_000}}")) {
      preferences.edit().putString("synthetic_validation_session", invalid).commit()
      val callsBeforeRead = transport.calls.get()
      assertEquals(null, storage.syntheticValidationSession())
      assertFalse(preferences.contains("synthetic_validation_session"))
      assertEquals(callsBeforeRead, transport.calls.get())
    }
    reopened.setSyntheticValidationSession(token, System.currentTimeMillis() + 60_000)
    reopened.updateConsent("withdrawn", "synthetic-policy"); reopened.pendingCount()
    assertEquals(null, storage.syntheticValidationSession())
    assertTrue(diagnostics(reopened).consentBarrierActive)
    assertEquals(2, transport.tokens.size)
    reopened.setSyntheticValidationSession(token, System.currentTimeMillis() + 60_000)
    assertTrue(resetResult(reopened))
    assertEquals(null, storage.syntheticValidationSession())
    assertEquals(2, transport.tokens.size)
    val legacy = sdk(RecordingTransport(true))
    org.junit.Assert.assertThrows(UnsupportedOperationException::class.java) {
      legacy.setSyntheticValidationSession(token, System.currentTimeMillis() + 60_000)
    }
    legacy.clearSyntheticValidationSession()
  }

  @Test fun `diagnostics read is local closed and does not create an identity or guess custom HTTP`() {
    val transport = RecordingTransport(false)
    val sdk = sdk(transport)
    sdk.setCollectionEnabled(false)
    val preferences = context.getSharedPreferences(OpenMasuStorage.PREFERENCES, Context.MODE_PRIVATE)
    val before = preferences.all
    val initial = diagnostics(sdk)
    assertFalse(initial.collectionEnabled)
    assertFalse(initial.enrolled)
    assertEquals(OpenMasuRetryState.COLLECTION_BLOCKED, initial.retryState)
    assertEquals(OpenMasuDiagnosticResult.NOT_ATTEMPTED, initial.lastResult)
    assertEquals(null, initial.lastAttemptAtMs)
    assertEquals(0, initial.queue.pendingCount)
    assertEquals(before, preferences.all)
    assertFalse(preferences.contains("installation_id"))
    assertEquals(0, transport.calls.get())
    OpenMasuStorage(context).applyConsentState("withdrawn")
    assertTrue(diagnostics(sdk).consentBarrierActive)
    OpenMasuStorage(context).applyConsentState("granted")
    sdk.setCollectionEnabled(true)
    sdk.startSession()
    sdk.pendingCount() // Wait for this deliberate send, not for the diagnostic getter.
    val attempted = diagnostics(sdk)
    assertEquals(OpenMasuDiagnosticResult.CUSTOM_FAILURE, attempted.lastResult)
    assertEquals(OpenMasuHttpClass.NONE, attempted.httpClass)
    assertEquals(OpenMasuRetryState.PENDING, attempted.retryState)
    val keys = OpenMasuDiagnosticsSnapshot::class.java.declaredFields.filter { !it.isSynthetic }.map { it.name }.toSet()
    assertEquals(setOf("collectionEnabled", "consentBarrierActive", "resetPending", "enrolled", "lastAttemptAtMs", "lastOperation", "lastResult", "httpClass", "retryState", "queue"), keys)
    assertFalse(attempted.toString().contains("synthetic-secret"))
  }

  @Test fun `diagnostic getter can read while the delivery executor is blocked`() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val transport = object : OpenMasuTransport {
      override fun enroll(installationId: String) = InstallationCredential("synthetic-key", "synthetic-secret")
      override fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean {
        entered.countDown()
        check(release.await(5, TimeUnit.SECONDS))
        return true
      }
      override fun deleteInstallation(credential: InstallationCredential, installationId: String) = true
    }
    val sdk = sdk(transport)
    sdk.startSession()
    try {
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      assertEquals(OpenMasuDiagnosticResult.IN_FLIGHT, diagnostics(sdk).lastResult)
    } finally { release.countDown() }
    sdk.pendingCount()
    assertEquals(OpenMasuDiagnosticResult.CUSTOM_SUCCESS, diagnostics(sdk).lastResult)
  }

  @Test fun `HTTP diagnostics distinguish 401 429 202 and offline and survive a separate SDK instance`() {
    val status = AtomicInteger(401)
    val captured = java.util.concurrent.CopyOnWriteArrayList<Pair<String, Map<String, String>>>()
    val server = java.net.ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
    val serving = Thread {
      while (!server.isClosed) runCatching {
        server.accept().use { socket ->
          socket.soTimeout = 2_000
          val reader = socket.getInputStream().bufferedReader()
          var length = 0
          val headers = mutableMapOf<String, String>()
          while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            if (line.contains(':')) headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
            if (line.startsWith("Content-Length:", true)) length = line.substringAfter(':').trim().toInt()
          }
          val requestBody = StringBuilder()
          repeat(length) { requestBody.append(reader.read().toChar()) }
          captured += requestBody.toString() to headers
          val body = "synthetic-private-provider-body"
          socket.getOutputStream().write("HTTP/1.1 ${status.get()} Synthetic\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n$body".toByteArray())
        }
      }
    }.also { it.isDaemon = true; it.start() }
    try {
      val config = OpenMasuConfiguration("http://127.0.0.1:${server.localPort}", "sdk-key:synthetic", "synthetic-secret", timeoutMs = 2_000)
      OpenMasuStorage(context).setCredential(InstallationCredential("synthetic-key", "synthetic-credential"))
      val sdk = sdk(HmacHttpTransport(config), configuration = config)
      sdk.startSession()
      sdk.pendingCount()
      assertEquals(EventFactory.envelope(sdk.pendingEvents(), config.sdkVersion, config.wrapperVersion), captured.last().first)
      assertEquals(OpenMasuDiagnosticResult.AUTHENTICATION_REJECTED, diagnostics(sdk).lastResult)
      status.set(429)
      assertFalse(sdk.flushBlocking())
      assertEquals(OpenMasuDiagnosticResult.RATE_LIMITED, diagnostics(sdk).lastResult)
      assertEquals(OpenMasuHttpClass.HTTP_4XX, diagnostics(sdk).httpClass)
      status.set(202)
      val validationToken = "A".repeat(43)
      sdk.setSyntheticValidationSession(validationToken, System.currentTimeMillis() + 60_000)
      assertFalse(sdk.pendingEvents().any { it.payloadJson.contains(validationToken) })
      assertTrue(sdk.flushBlocking())
      val (signedBody, signedHeaders) = captured.last()
      val envelope = JSONObject(signedBody)
      assertEquals(validationToken, envelope.getString("validation_session_token"))
      assertFalse(envelope.getJSONArray("records").toString().contains(validationToken))
      val canonical = SdkRequestSigner.canonical("POST", "/v1/events/batch", config.sdkKeyId, "synthetic-key",
        signedHeaders.getValue("x-openmasu-timestamp-ms").toLong(), signedHeaders.getValue("x-openmasu-nonce"), signedBody.toByteArray())
      assertEquals(SdkRequestSigner.sign("synthetic-credential", canonical), signedHeaders["x-openmasu-signature"])
      val accepted = diagnostics(sdk)
      assertEquals(OpenMasuDiagnosticResult.ACCEPTED, accepted.lastResult)
      assertEquals(OpenMasuHttpClass.HTTP_2XX, accepted.httpClass)
      assertEquals(0, accepted.queue.pendingCount)
      assertFalse(accepted.toString().contains("synthetic-private-provider-body"))
      server.close()
      serving.join(3_000)
      sdk.startSession()
      sdk.pendingCount()
      val offline = diagnostics(sdk)
      assertEquals(OpenMasuDiagnosticResult.NETWORK_UNAVAILABLE, offline.lastResult)
      assertEquals(OpenMasuHttpClass.NONE, offline.httpClass)
      assertEquals(OpenMasuRetryState.PENDING, offline.retryState)
      sdk.close(); created.remove(sdk)
      val reopened = sdk(RecordingTransport(false), configuration = config)
      assertEquals(offline, diagnostics(reopened))
    } finally { server.close(); serving.join(3_000) }
  }

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

  @Test fun `injected Unity provider readers flow once into the install evidence`() {
    val playReads = AtomicInteger()
    val metaReads = AtomicInteger()
    val sdk = sdk(
      RecordingTransport(false),
      PlayReferrerReader {
        playReads.incrementAndGet()
        PlayReferrerEvidence(
          status = "available",
          clientResponse = "ok",
          clickId = "click-synthetic-provider-17",
          referrer = "cid=click-synthetic-provider-17",
        )
      },
      MetaReferrerReader {
        metaReads.incrementAndGet()
        MetaReferrerEvidence(
          status = "decrypt_pending",
          installReferrer = "synthetic-protected-referrer",
          providerAuthority = "synthetic.provider.InstallReferrerProvider",
        )
      },
    )
    sdk.initialize()
    await { sdk.pendingEvents().any { it.eventName == "install" } }

    val payload = JSONObject(sdk.pendingEvents().single { it.eventName == "install" }.payloadJson)
    assertEquals(1, playReads.get())
    assertEquals(1, metaReads.get())
    assertEquals("available", payload.getString("referrer_status"))
    assertEquals("click-synthetic-provider-17", payload.getString("click_id"))
    assertEquals("decrypt_failed", payload.getString("meta_referrer_status"))
    assertEquals(
      "synthetic-protected-referrer",
      payload.getJSONObject("extensions").getString("meta_install_referrer_protected"),
    )
    sdk.initialize()
    Thread.sleep(100)
    assertEquals(1, playReads.get())
    assertEquals(1, metaReads.get())
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

  @Test fun `persisted consent barrier re-purges after restart and blocks new measurement`() {
    val storage = OpenMasuStorage(context)
    val database = OpenMasuQueueDatabase.open(context)
    try {
      Thread {
        database.queue().insert(QueuedEvent(
          "event:synthetic-restart-analytics", "session_start", "analytics",
          "{\"event_name\":\"session_start\"}", EventFactory.canonicalNow(), 1, 1,
        ))
        database.queue().insert(QueuedEvent(
          "event:synthetic-restart-control", "consent_changed", "fraud_prevention",
          "{\"event_name\":\"consent_changed\"}", EventFactory.canonicalNow(), 2, 2,
        ))
      }.apply { start(); join() }
      storage.applyConsentState("withdrawn")
    } finally { database.close() }

    val sdk = sdk(RecordingTransport(false))
    sdk.initialize()
    sdk.startSession()
    sdk.trackCustomEvent("blocked_after_restart")
    sdk.enqueueAdRevenue(JSONObject()
      .put("event_name", "ad_revenue").put("subject_scope", "installation_level")
      .put("installation_id", sdk.installationId()).put("ad_network", "synthetic")
      .put("amount_unscaled", "1").put("amount_scale", 6).put("currency", "USD")
      .put("revenue_source", "client_estimated").put("revenue_precision", "exact"))
    await { sdk.pendingEvents().none { it.processingPurposeId in setOf("attribution", "analytics", "revenue_measurement") } }
    assertEquals(setOf("fraud_prevention"), sdk.pendingEvents().map { it.processingPurposeId }.toSet())

    sdk.updateConsent("unknown", "synthetic-policy-unknown")
    sdk.trackCustomEvent("still_blocked")
    await { sdk.pendingEvents().any { it.eventName == "consent_changed" } }
    assertTrue(sdk.pendingEvents().none { it.eventName == "custom_event" })

    sdk.updateConsent("granted", "synthetic-policy-granted")
    sdk.trackCustomEvent("allowed_after_grant")
    await { sdk.pendingEvents().any { it.eventName == "custom_event" } }
  }

  @Test fun `queue capacity protects revenue over analytics and always admits the latest consent`() {
    val sdk = sdk(
      RecordingTransport(false),
      configuration = OpenMasuConfiguration(
        "http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret",
        maxQueueRecords = 2, maxQueueBytes = 65_536,
      ),
    )
    sdk.initialize()
    await { sdk.pendingEvents().any { it.eventName == "install" } }
    sdk.enqueueAdRevenue(JSONObject()
      .put("event_name", "ad_revenue").put("subject_scope", "installation_level")
      .put("installation_id", sdk.installationId()).put("ad_network", "synthetic")
      .put("amount_unscaled", "1").put("amount_scale", 6).put("currency", "USD")
      .put("revenue_source", "client_estimated").put("revenue_precision", "exact"))
    await { sdk.pendingCount() == 2 }

    sdk.trackCustomEvent("rejected_while_protected_is_full")
    await { sdk.queueHealth().rejectedTotal == 1L }
    assertEquals(setOf("install", "ad_revenue"), sdk.pendingEvents().map { it.eventName }.toSet())

    sdk.updateConsent("unknown", "synthetic-policy-capacity")
    await { sdk.pendingEvents().any { it.eventName == "consent_changed" } }
    val health = sdk.queueHealth()
    assertEquals(2, health.pendingCount)
    assertEquals(1L, health.evictedTotal)
    assertEquals(1L, health.rejectedTotal)
    assertEquals(setOf("ad_revenue", "consent_changed"), sdk.pendingEvents().map { it.eventName }.toSet())
  }

  @Test fun `queue byte accounting uses UTF-8 and duplicate admission never evicts`() {
    val database = OpenMasuQueueDatabase.open(context)
    val executor = Executors.newSingleThreadExecutor()
    try {
      val result = executor.submit<List<Any>> {
        val ascii = QueuedEvent(
          "event:ascii", "custom_event", "analytics", "{\"value\":\"a\"}",
          "2026-08-26T00:00:00.000Z", 1, 1,
        )
        val multibyte = QueuedEvent(
          "event:multibyte", "custom_event", "analytics", "{\"value\":\"枡枡枡\"}",
          "2026-08-26T00:00:00.000Z", 2, 2,
        )
        val first = database.queue().admit(ascii, 10, multibyte.logicalQueueBytes())
        val second = database.queue().admit(multibyte, 10, multibyte.logicalQueueBytes())
        val duplicate = database.queue().admit(multibyte, 1, multibyte.logicalQueueBytes())
        listOf(first, second, duplicate, database.queue().pending(10), database.queue().logicalBytes(), multibyte.logicalQueueBytes())
      }.get(5, TimeUnit.SECONDS)
      assertEquals(QueueAdmissionResult(true, 0, 0), result[0])
      assertEquals(QueueAdmissionResult(true, 1, 0), result[1])
      assertEquals(QueueAdmissionResult(true, 0, 0), result[2])
      assertEquals(listOf("event:multibyte"), (result[3] as List<*>).map { (it as QueuedEvent).eventId })
      assertEquals(result[5], result[4])
    } finally {
      executor.shutdownNow()
      database.close()
    }
  }

  @Test fun `Android queue matches the shared duplicate and conflict vectors`() {
    val vectorFile = generateSequence(File(System.getProperty("user.dir") ?: ".")) { it.parentFile }
      .map { File(it, "sdk/queue-semantics-vectors.json") }
      .first { it.isFile }
    val vectors = JSONObject(vectorFile.readText()).getJSONArray("vectors")
    val executor = Executors.newSingleThreadExecutor()
    try {
      for (index in 0 until vectors.length()) {
        context.filesDir.resolve(OpenMasuStorage.SUBTREE).deleteRecursively()
        val vector = vectors.getJSONObject(index)
        val existing = queueVectorEvent(vector.getJSONObject("existing"))
        val incoming = queueVectorEvent(vector.getJSONObject("incoming"))
        val database = OpenMasuQueueDatabase.open(context)
        try {
          val result = executor.submit<Pair<String, List<QueuedEvent>>> {
            assertEquals(QueueAdmissionResult(true, 0, 0), database.queue().admit(existing, 10, 65_536))
            val outcome = try {
              assertEquals(QueueAdmissionResult(true, 0, 0), database.queue().admit(incoming, 10, 65_536))
              "duplicate"
            } catch (error: IllegalStateException) {
              assertEquals("queue_event_conflict", error.message)
              "conflict"
            }
            outcome to database.queue().pending(10)
          }.get(5, TimeUnit.SECONDS)
          assertEquals(vector.getString("name"), vector.getString("outcome"), result.first)
          assertEquals(vector.getString("name"), listOf(existing), result.second)
        } finally {
          database.close()
        }
      }
    } finally {
      executor.shutdownNow()
    }
  }

  @Test fun `queue database version one migrates without losing pending evidence`() {
    val subtree = context.filesDir.resolve(OpenMasuStorage.SUBTREE).apply { mkdirs() }
    val queueFile = subtree.resolve("queue.db")
    SQLiteDatabase.openOrCreateDatabase(queueFile, null).use { legacy ->
      legacy.execSQL("""
        CREATE TABLE queued_events (
          eventId TEXT NOT NULL, eventName TEXT NOT NULL, processingPurposeId TEXT NOT NULL,
          payloadJson TEXT NOT NULL, occurredAt TEXT NOT NULL, processingSequence INTEGER NOT NULL,
          createdAtEpochMs INTEGER NOT NULL, PRIMARY KEY(eventId)
        )
      """.trimIndent())
      legacy.execSQL("""
        INSERT INTO queued_events VALUES (
          'event:legacy', 'install', 'attribution', '{"event_name":"install"}',
          '2026-08-26T00:00:00.000Z', 1, 1
        )
      """.trimIndent())
      legacy.execSQL("CREATE TABLE room_master_table (id INTEGER PRIMARY KEY, identity_hash TEXT)")
      legacy.execSQL("INSERT INTO room_master_table VALUES (42, '3b7188418b7c305b460540ab3e8c1a3d')")
      legacy.version = 1
    }

    val database = OpenMasuQueueDatabase.open(context)
    val executor = Executors.newSingleThreadExecutor()
    try {
      val result = executor.submit<Pair<List<String>, QueueStats?>> {
        database.queue().pending(10).map { it.eventId } to database.queue().stats()
      }.get(5, TimeUnit.SECONDS)
      assertEquals(listOf("event:legacy"), result.first)
      assertEquals(null, result.second)
      assertEquals(2, SQLiteDatabase.openDatabase(queueFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { it.version })
    } finally {
      executor.shutdownNow()
      database.close()
    }
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

  @Test fun `protected purchase callbacks acknowledge durable admission and idempotent retries only`() {
    val sdk = sdk(RecordingTransport(false), configuration = OpenMasuConfiguration(
      "http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret", maxQueueRecords = 2,
    ))
    repeat(2) {
      assertEquals(OpenMasuPurchaseQueueResult.QUEUED, purchaseResult { completed ->
        sdk.trackGooglePlayProductPurchase(
          "synthetic-purchase-token-239", "product.synthetic.239", "transaction:synthetic-239",
          "199", 2, "USD", completed,
        )
      })
    }
    assertEquals(OpenMasuPurchaseQueueResult.QUEUED, purchaseResult { completed ->
      sdk.trackGooglePlaySubscriptionPurchase(
        "synthetic-subscription-token-239", "subscription.synthetic.239", "transaction:subscription-239",
        "999", 2, "USD", completed,
      )
    })
    assertEquals(OpenMasuPurchaseQueueResult.QUEUE_REJECTED, purchaseResult { completed ->
      sdk.trackGooglePlayProductPurchase(
        "synthetic-rejected-token-239", "product.synthetic.239", "transaction:rejected-239",
        "299", 2, "USD", completed,
      )
    })
    val pending = sdk.pendingEvents()
    assertEquals(2, pending.size)
    assertTrue(pending.all { JSONObject(it.payloadJson).getString("financial_status") == "pending" })
    assertTrue(pending.none { it.eventId.contains("synthetic-purchase-token-239") })
  }

  @Test fun `protected purchase callbacks refuse disabled collection and withdrawn consent`() {
    val sdk = sdk(RecordingTransport(false))
    sdk.setCollectionEnabled(false)
    fun submit() = purchaseResult { completed ->
      sdk.trackGooglePlayProductPurchase(
        "synthetic-disabled-token-239", "product.synthetic.239", "transaction:disabled-239",
        "199", 2, "USD", completed,
      )
    }
    assertEquals(OpenMasuPurchaseQueueResult.COLLECTION_DISABLED, submit())
    sdk.setCollectionEnabled(true)
    val updated = CountDownLatch(1)
    sdk.updateConsent("withdrawn", "synthetic-policy-239") { success ->
      assertTrue(success)
      updated.countDown()
    }
    assertTrue(updated.await(5, TimeUnit.SECONDS))
    assertEquals(OpenMasuPurchaseQueueResult.CONSENT_REQUIRED, submit())
    assertTrue(sdk.pendingEvents().none { it.eventName == "purchase" })
  }

  @Test fun `consent callback refusal does not roll back the privacy purge`() {
    val sdk = sdk(RecordingTransport(false), configuration = OpenMasuConfiguration(
      "http://127.0.0.1", "sdk-key:synthetic", "synthetic-secret", maxQueueBytes = 65_536,
    ))
    assertEquals(OpenMasuPurchaseQueueResult.QUEUED, purchaseResult { completed ->
      sdk.trackGooglePlayProductPurchase(
        "synthetic-purge-token-239", "product.synthetic.239", "transaction:purge-239",
        "199", 2, "USD", completed,
      )
    })
    val result = AtomicReference<Boolean>()
    val completed = CountDownLatch(1)
    sdk.updateConsent("withdrawn", "x".repeat(70_000)) { result.set(it); completed.countDown() }
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    assertFalse(result.get())
    assertTrue(OpenMasuStorage(context).consentBarrierActive())
    assertTrue(sdk.pendingEvents().none { it.eventName == "purchase" })
  }

  @Test fun `withdrawal and regrant invalidate a protected purchase waiting on the native executor`() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val sdk = sdk(RecordingTransport(false), PlayReferrerReader {
      entered.countDown()
      check(release.await(5, TimeUnit.SECONDS))
      PlayReferrerEvidence("none", "ok")
    })
    sdk.initialize()
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    val result = AtomicReference<OpenMasuPurchaseQueueResult>()
    val completed = CountDownLatch(1)
    try {
      sdk.trackGooglePlaySubscriptionPurchase(
        "synthetic-race-token-239", "subscription.synthetic.239", "transaction:race-239",
        "999", 2, "USD",
      ) { result.set(it); completed.countDown() }
      sdk.updateConsent("withdrawn", "synthetic-policy-239")
      sdk.updateConsent("granted", "synthetic-policy-239")
    } finally { release.countDown() }
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    assertEquals(OpenMasuPurchaseQueueResult.CONTEXT_CHANGED, result.get())
    assertTrue(sdk.pendingEvents().none { it.eventName == "purchase" })
  }

  @Test fun `installation reset invalidates protected purchase work already waiting on the executor`() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val sdk = sdk(RecordingTransport(true), PlayReferrerReader {
      entered.countDown()
      check(release.await(5, TimeUnit.SECONDS))
      PlayReferrerEvidence("none", "ok")
    })
    sdk.initialize()
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    val result = AtomicReference<OpenMasuPurchaseQueueResult>()
    val completed = CountDownLatch(1)
    val reset = CountDownLatch(1)
    val oldId = sdk.installationId()
    try {
      sdk.trackGooglePlayProductPurchase(
        "synthetic-reset-token-239", "product.synthetic.239", "transaction:reset-239",
        "199", 2, "USD",
      ) { result.set(it); completed.countDown() }
      sdk.resetInstallationId { success -> assertTrue(success); reset.countDown() }
    } finally { release.countDown() }
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    assertTrue(reset.await(5, TimeUnit.SECONDS))
    assertEquals(OpenMasuPurchaseQueueResult.CONTEXT_CHANGED, result.get())
    assertNotEquals(oldId, sdk.installationId())
    assertTrue(sdk.pendingEvents().none { it.eventName == "purchase" })
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

  @Test fun `reset while consent is withdrawn defers the new install until explicit grant`() {
    val transport = RecordingTransport(true)
    val sdk = sdk(transport)
    sdk.initialize()
    await { transport.deliveries.get() == 1 }
    sdk.updateConsent("withdrawn", "synthetic-policy-withdrawn")
    await { transport.deliveries.get() == 2 }

    val complete = CountDownLatch(1)
    var resetResult = false
    sdk.resetInstallationId { resetResult = it; complete.countDown() }
    assertTrue(complete.await(5, TimeUnit.SECONDS))
    assertTrue(resetResult)
    assertTrue(OpenMasuStorage(context).resetInstallPending())
    assertTrue(sdk.pendingEvents().none { it.eventName == "install" })

    sdk.updateConsent("granted", "synthetic-policy-granted")
    await { transport.deliveredPayloads.flatten().any {
      it.eventName == "install" && it.payloadJson.contains("\"install_origin\":\"identifier_reset\"")
    } }
    assertFalse(OpenMasuStorage(context).resetInstallPending())
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

  @Test fun `pending deletion survives reopen and blocks collection until one replacement is ready`() {
    val transport = ReceiptTransport()
    val sdk = sdk(transport)
    sdk.initialize()
    await { transport.deliveries.get() == 1 }
    val oldId = sdk.installationId()
    transport.deliverySucceeds = false
    sdk.startSession()
    await { sdk.pendingCount() == 1 }

    assertFalse(resetResult(sdk))
    val receipt = OpenMasuStorage(context).deletionReceipt()
    assertEquals(64, receipt?.length)
    assertEquals(oldId, sdk.installationId())
    assertEquals(0, sdk.pendingCount())
    assertFalse(sdk.isCollectionEnabled())
    val deliveriesBeforeGrant = transport.deliveries.get()
    val diagnostic = diagnostics(sdk)
    assertTrue(diagnostic.resetPending)
    assertEquals(OpenMasuRetryState.RESET_PENDING, diagnostic.retryState)
    assertEquals(OpenMasuDiagnosticResult.CUSTOM_SUCCESS, diagnostic.lastResult)
    sdk.updateConsent("granted", "synthetic-policy-granted")
    sdk.setCollectionEnabled(false)
    sdk.setCollectionEnabled(true)
    sdk.startSession()
    assertEquals(0, sdk.pendingCount())
    assertFalse(sdk.isCollectionEnabled())
    assertEquals(deliveriesBeforeGrant, transport.deliveries.get())

    sdk.close()
    created.remove(sdk)
    val reopened = sdk(transport)
    reopened.initialize()
    assertEquals(0, reopened.pendingCount())
    assertEquals(receipt, OpenMasuStorage(context).deletionReceipt())
    assertEquals(oldId, reopened.installationId())
    transport.deliverySucceeds = true
    transport.state = DeletionStatus.COMPLETED
    assertTrue(reopened.flushBlocking())
    val replacement = reopened.installationId()
    assertNotEquals(oldId, replacement)
    assertEquals(null, OpenMasuStorage(context).deletionReceipt())
    assertTrue(reopened.flushBlocking())
    assertEquals(replacement, reopened.installationId())
    assertEquals(1, transport.beginCalls.get())
    assertEquals(listOf(oldId, replacement), transport.enrolledInstallations)
    assertEquals(1, transport.resetInstalls().size)
  }

  @Test fun `lost deletion response recovers by receipt without resubmitting deletion`() {
    val transport = ReceiptTransport().apply { completeOnBegin = true; loseBeginResponse = true }
    val sdk = sdk(transport)
    sdk.initialize()
    await { transport.deliveries.get() == 1 }
    val oldId = sdk.installationId()
    assertFalse(resetResult(sdk))
    assertEquals(oldId, sdk.installationId())
    val receipt = OpenMasuStorage(context).deletionReceipt()
    sdk.close()
    created.remove(sdk)

    val reopened = sdk(transport)
    reopened.initialize()
    assertTrue(reopened.flushBlocking())
    assertNotEquals(oldId, reopened.installationId())
    assertEquals(receipt, transport.receipt)
    assertEquals(1, transport.beginCalls.get())
    assertEquals(2, transport.enrolledInstallations.size)
    assertEquals(1, transport.resetInstalls().size)
  }

  @Test fun `completed deletion does not repeat when replacement enrollment is retried`() {
    val transport = ReceiptTransport().apply { completeOnBegin = true }
    val sdk = sdk(transport)
    sdk.initialize()
    await { transport.deliveries.get() == 1 }
    val oldId = sdk.installationId()
    transport.enrollmentFailures.set(1)
    assertFalse(resetResult(sdk))
    val replacement = sdk.installationId()
    assertNotEquals(oldId, replacement)
    assertTrue(OpenMasuStorage(context).resetInstallPending())
    assertTrue(resetResult(sdk))
    assertEquals(replacement, sdk.installationId())
    assertEquals(1, transport.beginCalls.get())
    assertEquals(listOf(oldId, replacement, replacement), transport.enrolledInstallations)
    assertEquals(1, transport.resetInstalls().size)
  }

  private fun sdk(
    transport: OpenMasuTransport,
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

  private fun queueVectorEvent(value: JSONObject): QueuedEvent = QueuedEvent(
    eventId = value.getString("event_id"),
    eventName = value.getString("event_name"),
    processingPurposeId = value.getString("purpose"),
    payloadJson = value.getString("payload"),
    occurredAt = value.getString("occurred_at"),
    processingSequence = value.getLong("sequence"),
    createdAtEpochMs = value.getLong("enqueued_at_ms"),
  )

  private fun await(condition: () -> Boolean) {
    repeat(100) { if (condition()) return; Thread.sleep(25) }
    error("condition_not_met")
  }

  private fun diagnostics(sdk: OpenMasuSdk): OpenMasuDiagnosticsSnapshot {
    val result = AtomicReference<OpenMasuDiagnosticsSnapshot>()
    val completed = CountDownLatch(1)
    sdk.diagnosticsSnapshot { result.set(it); completed.countDown() }
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    return result.get()
  }

  private fun purchaseResult(
    submit: ((OpenMasuPurchaseQueueResult) -> Unit) -> Unit,
  ): OpenMasuPurchaseQueueResult {
    val result = AtomicReference<OpenMasuPurchaseQueueResult>()
    val completed = CountDownLatch(1)
    submit { result.set(it); completed.countDown() }
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    return result.get()
  }

  private fun resetResult(sdk: OpenMasuSdk): Boolean {
    val result = AtomicReference<Boolean>()
    val completed = CountDownLatch(1)
    sdk.resetInstallationId { result.set(it); completed.countDown() }
    assertTrue(completed.await(5, TimeUnit.SECONDS))
    return result.get()
  }

  private class ReceiptTransport : OpenMasuDeletionTransport {
    val beginCalls = AtomicInteger()
    val deliveries = AtomicInteger()
    val enrollmentFailures = AtomicInteger()
    val enrolledInstallations = mutableListOf<String>()
    private val deliveredPayloads = mutableListOf<List<QueuedEvent>>()
    @Volatile var state = DeletionStatus.MISSING
    @Volatile var receipt: String? = null
    @Volatile var completeOnBegin = false
    @Volatile var loseBeginResponse = false
    @Volatile var deliverySucceeds = true

    override fun enroll(installationId: String): InstallationCredential {
      enrolledInstallations += installationId
      if (enrollmentFailures.get() > 0) {
        enrollmentFailures.decrementAndGet()
        error("synthetic_enrollment_failure")
      }
      return InstallationCredential("installation-key:synthetic", "synthetic-installation-secret")
    }
    override fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean {
      deliveredPayloads += events
      deliveries.incrementAndGet()
      return deliverySucceeds
    }
    override fun beginDeletion(credential: InstallationCredential, installationId: String, receipt: String): DeletionStatus {
      beginCalls.incrementAndGet()
      check(this.receipt == null || this.receipt == receipt)
      this.receipt = receipt
      state = if (completeOnBegin) DeletionStatus.COMPLETED else DeletionStatus.PROCESSING
      if (loseBeginResponse) error("synthetic_lost_response")
      return state
    }
    override fun deletionStatus(receipt: String): DeletionStatus =
      if (this.receipt == receipt) state else DeletionStatus.MISSING
    override fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean =
      error("receipt_capability_must_be_used")
    fun resetInstalls(): List<QueuedEvent> = deliveredPayloads.flatten().filter {
      it.eventName == "install" && it.payloadJson.contains("\"install_origin\":\"identifier_reset\"")
    }
  }

  private class SyntheticValidationTransport : OpenMasuSyntheticValidationTransport {
    val calls = AtomicInteger()
    val normalCalls = AtomicInteger()
    val tokens = java.util.concurrent.CopyOnWriteArrayList<String>()
    override fun enroll(installationId: String): InstallationCredential {
      calls.incrementAndGet()
      return InstallationCredential("synthetic-key", "synthetic-secret")
    }
    override fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean {
      calls.incrementAndGet(); normalCalls.incrementAndGet(); return true
    }
    override fun deliverWithDiagnostics(credential: InstallationCredential, events: List<QueuedEvent>) { deliver(credential, events) }
    override fun deliverForSyntheticValidation(credential: InstallationCredential, events: List<QueuedEvent>, sessionToken: String) {
      calls.incrementAndGet(); tokens += sessionToken
      assertFalse(events.any { it.payloadJson.contains(sessionToken) })
    }
    override fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean { calls.incrementAndGet(); return true }
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
