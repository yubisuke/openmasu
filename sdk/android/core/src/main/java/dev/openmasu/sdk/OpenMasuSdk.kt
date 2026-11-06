package dev.openmasu.sdk

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.time.Duration
import java.time.Instant

data class OpenMasuConfiguration @JvmOverloads constructor(
  val endpoint: String,
  val sdkKeyId: String,
  val sdkSecret: String,
  val sdkVersion: String = OpenMasuStorage.SDK_VERSION,
  val wrapperVersion: String? = null,
  val timeoutMs: Int = 10_000,
  val deepLinkHosts: Set<String> = emptySet(),
  val deepLinkSchemes: Set<String> = emptySet(),
  val deferredDeepLinkTtlSeconds: Long = 604800,
  val maxQueueRecords: Int = OpenMasuQueueDefaults.MAX_RECORDS,
  val maxQueueBytes: Long = OpenMasuQueueDefaults.MAX_BYTES,
) {
  init {
    require(maxQueueRecords in 1..100_000)
    require(maxQueueBytes in 65_536L..268_435_456L)
  }
}

/** Local queue admission only; a queued purchase has not been store-verified. */
enum class OpenMasuPurchaseQueueResult {
  QUEUED, COLLECTION_DISABLED, CONSENT_REQUIRED, INSTALLATION_CHANGED, CONTEXT_CHANGED, QUEUE_REJECTED, NATIVE_FAILURE,
}

class OpenMasuSdk private constructor(
  private val context: Context,
  private val configuration: OpenMasuConfiguration,
  private val transport: OpenMasuTransport,
  private val playReader: PlayReferrerReader,
  private val metaReader: MetaReferrerReader,
  private val backstopScheduler: (Context) -> Unit,
) {
  private val storage = OpenMasuStorage(context)
  private val database = OpenMasuQueueDatabase.open(context)
  private val executor = Executors.newSingleThreadExecutor()
  private val initialized = AtomicBoolean(false)
  private val measurementRevision = AtomicLong()
  private val defaultCollectionEnabled = manifestCollectionDefault(context)
  @Volatile private var deepLinkListener: OpenMasuDeepLinkListener? = null

  fun initialize() {
    if (!initialized.compareAndSet(false, true)) return
    storage.persistConfiguration(configuration)
    if (storage.deletionReceipt() != null) {
      executor.execute { resumeDeletion() }
      return
    }
    if (!isCollectionEnabled()) return
    executor.execute {
      purgeConsentRequiredQueueIfBlocked()
      if (storage.consentBarrierActive("attribution")) {
        drain()
        return@execute
      }
      if (storage.resetInstallPending()) {
        completePendingResetInstall()
        return@execute
      }
      val installationId = storage.installationId()
      if (!storage.referrerConsumed()) {
        val consent = storage.consentSnapshot("attribution")
        val play = normalizeDeferred(playReader.read())
        val meta = metaReader.read()
        enqueueJson("install", "attribution", EventFactory.install(installationId, configuration.wrapperVersion ?: configuration.sdkVersion, play, meta, "play_first_launch"), consent = consent)
        val deferred = DeepLinkParser.fromReferrer(play)
        if (deferred != null && !storage.deferredDestinationConsumed()) {
          deepLinkListener?.onDeepLink(deferred)
          enqueueJson("deep_link_open", "attribution", EventFactory.deepLink(installationId, deferred), consent = consent)
          storage.markDeferredDestinationConsumed()
        }
        if (!play.shouldRetry) storage.markReferrerConsumed()
      }
      drain()
    }
  }

  fun trackCustomEvent(eventKey: String, attributes: Map<String, Any?> = emptyMap()) {
    require(eventKey.matches(Regex("^[a-z][a-z0-9_]{0,63}$"))) { "event_key_invalid" }
    require(attributes.size <= 20) { "too_many_attributes" }
    if (!isCollectionEnabled()) return
    submitMeasurement("analytics") { consent, installationId ->
      enqueueJson("custom_event", "analytics", EventFactory.custom(installationId, eventKey, attributes), consent = consent)
    }
  }

  fun startSession() {
    if (!isCollectionEnabled()) return
    submitMeasurement("analytics") { consent, installationId ->
      enqueueJson("session_start", "analytics", EventFactory.session(installationId, EventFactory.newSessionId()), consent = consent)
    }
  }

  fun setDeepLinkListener(listener: OpenMasuDeepLinkListener?) {
    deepLinkListener = listener
  }

  fun handleDeepLink(intent: Intent): Boolean {
    val value = DeepLinkParser.direct(intent, configuration.deepLinkHosts, configuration.deepLinkSchemes) ?: return false
    deepLinkListener?.onDeepLink(value)
    if (isCollectionEnabled()) submitMeasurement("attribution") { consent, installationId ->
      enqueueJson("deep_link_open", "attribution", EventFactory.deepLink(installationId, value), consent = consent)
    }
    return true
  }

  @JvmOverloads
  fun enqueueAdRevenue(payload: JSONObject, eventId: String? = null) {
    if (!isCollectionEnabled()) return
    submitMeasurement("revenue_measurement") { consent, _ -> enqueueJson("ad_revenue", "revenue_measurement", payload, eventId, consent) }
  }

  fun trackPurchase(
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
  ) {
    if (!isCollectionEnabled()) return
    validateCommerceEvent(transactionId, amountUnscaled, amountScale, currency)
    submitMeasurement("revenue_measurement") { consent, installationId ->
      enqueueJson(
        "purchase",
        "revenue_measurement",
        EventFactory.purchase(
          installationId,
          transactionId,
          amountUnscaled,
          amountScale,
          currency,
        ),
        EventFactory.commerceEventId(
          "purchase", installationId, transactionId, null, amountUnscaled, amountScale, currency,
        ),
        consent,
      )
    }
  }

  /** Queues a Google Play one-time-product purchase for protected server verification. */
  @JvmOverloads
  fun trackGooglePlayProductPurchase(
    purchaseToken: String,
    productId: String,
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
    onComplete: ((OpenMasuPurchaseQueueResult) -> Unit)? = null,
  ) {
    enqueueGooglePlayPurchase(
      false, purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency, onComplete,
    )
  }

  /** Queues a Google Play initial subscription purchase for protected server verification. */
  @JvmOverloads
  fun trackGooglePlaySubscriptionPurchase(
    purchaseToken: String,
    productId: String,
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
    onComplete: ((OpenMasuPurchaseQueueResult) -> Unit)? = null,
  ) {
    enqueueGooglePlayPurchase(
      true, purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency, onComplete,
    )
  }

  private fun enqueueGooglePlayPurchase(
    subscription: Boolean,
    purchaseToken: String,
    productId: String,
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
    onComplete: ((OpenMasuPurchaseQueueResult) -> Unit)?,
  ) {
    if (!isCollectionEnabled()) {
      onComplete?.invoke(OpenMasuPurchaseQueueResult.COLLECTION_DISABLED)
      return
    }
    validateCommerceEvent(transactionId, amountUnscaled, amountScale, currency)
    require(purchaseToken.isNotEmpty() && purchaseToken.toByteArray(Charsets.UTF_8).size <= 64 * 1024) {
      "google_play_purchase_token_invalid"
    }
    require(productId.matches(Regex("^[A-Za-z0-9._:-]{1,255}$"))) { "google_play_product_id_invalid" }
    val revision = measurementRevision.get()
    val consent = storage.consentSnapshot("revenue_measurement")
    val installationId = storage.installationId()
    try {
      executor.execute {
        val result = runCatching {
          when {
            storage.deletionReceipt() != null && measurementRevision.get() != revision -> OpenMasuPurchaseQueueResult.CONTEXT_CHANGED
            !isCollectionEnabled() -> OpenMasuPurchaseQueueResult.COLLECTION_DISABLED
            storage.consentBarrierActive("revenue_measurement") -> OpenMasuPurchaseQueueResult.CONSENT_REQUIRED
            storage.installationId() != installationId -> OpenMasuPurchaseQueueResult.INSTALLATION_CHANGED
            measurementRevision.get() != revision -> OpenMasuPurchaseQueueResult.CONTEXT_CHANGED
            storage.consentSnapshot("revenue_measurement").revision != consent.revision -> OpenMasuPurchaseQueueResult.CONTEXT_CHANGED
            else -> {
              val extensions = JSONObject()
                .put("google_play_purchase_token_protected", purchaseToken)
                .put("google_play_product_id_protected", productId)
              if (subscription) extensions.put("google_play_purchase_kind", "subscription_initial")
              val eventId = if (subscription) EventFactory.googlePlaySubscriptionEventId(
                installationId, productId, purchaseToken, transactionId, amountUnscaled, amountScale, currency,
              ) else EventFactory.googlePlayProductEventId(
                installationId, productId, purchaseToken, transactionId, amountUnscaled, amountScale, currency,
              )
              val admitted = enqueueJson(
                "purchase", "revenue_measurement",
                EventFactory.purchase(
                  installationId, transactionId, amountUnscaled, amountScale, currency, "pending", extensions,
                ),
                eventId,
                consent,
              )
              if (admitted) OpenMasuPurchaseQueueResult.QUEUED else OpenMasuPurchaseQueueResult.QUEUE_REJECTED
            }
          }
        }.getOrDefault(OpenMasuPurchaseQueueResult.NATIVE_FAILURE)
        try {
          onComplete?.invoke(result)
        } finally {
          if (result == OpenMasuPurchaseQueueResult.QUEUED) drain()
        }
      }
    } catch (_: java.util.concurrent.RejectedExecutionException) {
      onComplete?.invoke(OpenMasuPurchaseQueueResult.NATIVE_FAILURE)
    }
  }

  fun trackRefund(
    transactionId: String,
    originalTransactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
  ) {
    if (!isCollectionEnabled()) return
    validateCommerceEvent(transactionId, amountUnscaled, amountScale, currency)
    require(originalTransactionId.matches(IDENTIFIER_PATTERN)) { "original_transaction_id_invalid" }
    submitMeasurement("revenue_measurement") { consent, installationId ->
      enqueueJson(
        "refund",
        "revenue_measurement",
        EventFactory.refund(
          installationId,
          transactionId,
          originalTransactionId,
          amountUnscaled,
          amountScale,
          currency,
        ),
        EventFactory.commerceEventId(
          "refund", installationId, transactionId, originalTransactionId,
          amountUnscaled, amountScale, currency,
        ),
        consent,
      )
    }
  }

  fun installationIdForMeasurement(): String = storage.installationId()
  fun flushBlocking(timeoutMs: Long = 10_000): Boolean =
    executor.submit<Boolean> { drain() }.get(timeoutMs, TimeUnit.MILLISECONDS)

  @JvmOverloads
  fun updateConsent(state: String, policyVersion: String, onComplete: ((Boolean) -> Unit)? = null) {
    updateConsentScope(null,state,policyVersion,onComplete)
  }

  @JvmOverloads
  fun updateConsentForPurpose(purpose: String, state: String, policyVersion: String, onComplete: ((Boolean) -> Unit)? = null) {
    require(purpose in OpenMasuStorage.CONSENT_PURPOSES) { "consent_purpose_invalid" }
    updateConsentScope(purpose,state,policyVersion,onComplete)
  }

  private fun updateConsentScope(purpose: String?, state: String, policyVersion: String, onComplete: ((Boolean) -> Unit)?) {
    val event = storage.recordConsent(state,policyVersion,purpose,configuration.maxQueueBytes)
    try {
      executor.execute {
        val updated = runCatching {
          var admitted = false
          storage.withConsentLock { database.runInTransaction {
            purgeConsentRequiredQueueIfBlocked()
            admitted = database.queue().admit(event,configuration.maxQueueRecords,configuration.maxQueueBytes).admitted
          } }
          admitted
        }.getOrDefault(false)
        try {
          onComplete?.invoke(updated)
        } finally {
          if (isCollectionEnabled()) {
            if ((state == "granted" || state == "not_required") && storage.resetInstallPending()) {
              completePendingResetInstall()
            } else {
              drain()
            }
          }
        }
      }
    } catch (_: java.util.concurrent.RejectedExecutionException) {
      onComplete?.invoke(false)
    }
  }

  fun setCollectionEnabled(enabled: Boolean) {
    if (!enabled) measurementRevision.incrementAndGet()
    storage.setCollectionEnabled(enabled)
    if (enabled) executor.execute { drain() }
  }

  fun isCollectionEnabled(): Boolean = storage.deletionReceipt() == null && storage.collectionEnabled(defaultCollectionEnabled)

  /** Local opt-in only; server expiry and synthetic-disposable deployment policy remain authoritative. */
  fun setSyntheticValidationSession(token: String, expiresAtMs: Long) {
    if (transport !is OpenMasuSyntheticValidationTransport) throw UnsupportedOperationException("synthetic_validation_transport_unsupported")
    val session = SyntheticValidationSession(token, expiresAtMs)
    require(session.isActive(System.currentTimeMillis())) { "synthetic_validation_session_invalid" }
    storage.setSyntheticValidationSession(session)
  }

  fun clearSyntheticValidationSession() { storage.setSyntheticValidationSession(null) }

  /** One bounded page, never queued or persisted. Callback runs on the SDK executor. */
  fun requestPrivacyPage(requestType: OpenMasuPrivacyRequestType, cursor: String? = null, pageSize: Int = 200,
    onComplete: (OpenMasuPrivacyResult) -> Unit) {
    val revision = measurementRevision.get()
    val consentCounter = storage.consentCounter()
    val installationId = storage.installationId()
    val wasResetting = storage.deletionReceipt() != null || storage.resetInstallPending()
    executor.execute {
      val result = try {
        val capable = transport as? OpenMasuPrivacyTransport
        val credential = storage.credential()
        when {
          !OpenMasuPrivacyPage.validRequest(cursor, pageSize) -> OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.INVALID_REQUEST)
          wasResetting || storage.deletionReceipt() != null || storage.resetInstallPending() -> OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.RESET_PENDING)
          revision != measurementRevision.get() || consentCounter != storage.consentCounter() || installationId != storage.installationId() -> OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.CONTEXT_CHANGED)
          capable == null -> OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.UNSUPPORTED)
          credential == null -> OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.NOT_ENROLLED)
          else -> {
            val json = capable.privacyPage(credential, installationId, requestType, cursor, pageSize)
            if (revision != measurementRevision.get() || consentCounter != storage.consentCounter() || installationId != storage.installationId() ||
              credential != storage.credential() || storage.deletionReceipt() != null || storage.resetInstallPending())
              OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.CONTEXT_CHANGED)
            else {
              val page = OpenMasuPrivacyPage.parse(json, requestType, pageSize)
              OpenMasuPrivacyResult(if (page.complete) OpenMasuPrivacyResultStatus.COMPLETE else OpenMasuPrivacyResultStatus.PAGE_READY, page)
            }
          }
        }
      } catch (_: Exception) { OpenMasuPrivacyResult(OpenMasuPrivacyResultStatus.REQUEST_FAILED) }
      onComplete(result)
    }
  }

  @JvmOverloads
  fun resetInstallationId(onComplete: (Boolean) -> Unit = {}) {
    clearSyntheticValidationSession()
    measurementRevision.incrementAndGet()
    val oldId = storage.installationId()
    // Enrollment already queued by initialize may not have completed yet.
    val receipt = if (storage.resetInstallPending() || storage.credential() == null) null else storage.beginDeletion()
    executor.execute {
      // Calls queued for the same receipt cannot reset its replacement again.
      val result = when {
        storage.installationId() != oldId || storage.resetInstallPending() -> completePendingResetInstall()
        storage.credential() == null -> false
        receipt != null && storage.deletionReceipt() != receipt -> completePendingResetInstall()
        else -> { storage.beginDeletion(); resumeDeletion() }
      }
      onComplete(result)
    }
  }

  private fun resumeDeletion(): Boolean {
    val receipt = storage.deletionReceipt() ?: return completePendingResetInstall()
    database.runInTransaction { database.queue().deleteAll() }
    return runCatching {
      val credential = storage.credential() ?: return false
      val status = if (transport is OpenMasuDeletionTransport) {
        val observed = observeTransport(OpenMasuDiagnosticOperation.DELETION_STATUS) { transport.deletionStatus(receipt) }
        if (observed == DeletionStatus.MISSING) observeTransport(OpenMasuDiagnosticOperation.DELETION) {
          transport.beginDeletion(credential, storage.installationId(), receipt)
        } else observed
      } else if (observeTransport(OpenMasuDiagnosticOperation.DELETION) {
        transport.deleteInstallation(credential, storage.installationId())
      }) DeletionStatus.COMPLETED else DeletionStatus.PROCESSING
      if (status != DeletionStatus.COMPLETED) { backstopScheduler(context); return false }
      completePendingResetInstall(storage.completeDeletion(receipt))
    }.getOrElse { backstopScheduler(context); false }
  }

  internal fun drain(): Boolean {
    if (storage.deletionReceipt() != null) return resumeDeletion()
    if (!isCollectionEnabled()) return false
    if (storage.resetInstallPending() && !storage.consentBarrierActive("attribution")) return completePendingResetInstall()
    val queued = storage.withConsentLock {
      purgeConsentRequiredQueueIfBlocked()
      database.queue().pending(97)
    }
    if (queued.isEmpty()) return true
    val sendingInstallationId = storage.installationId()
    val credential = runCatching { storage.credential() ?: ensureCredential(sendingInstallationId) }
      .getOrElse { backstopScheduler(context); return false }
    // A bounded prefix makes a declaration survive queue eviction and identity reset.
    // The declaration's transport ID is stable for this credential, never reused for its replacement.
    val batch = storage.withConsentLock {
      if (storage.deletionReceipt() != null || sendingInstallationId != storage.installationId()) return@withConsentLock emptyList<QueuedEvent>()
      val current = queued.filter { event -> event.processingPurposeId !in CONSENT_REQUIRED_PURPOSES ||
        storage.consentSnapshot(event.processingPurposeId).let { !it.blocked && it.revision == event.consentRevision } }
      (storage.consentDeclarations() + current).distinctBy { it.eventId }.map { event ->
        if (event.eventName != "consent_changed") event else event.copy(eventId = "event:consent:" +
          SdkRequestSigner.sha256((sendingInstallationId + "\n" + credential.keyId + "\n" + event.eventId).toByteArray(Charsets.UTF_8)))
      }
    }
    if (batch.isEmpty()) return false
    return if (runCatching {
      observeTransport(OpenMasuDiagnosticOperation.DELIVERY) {
        val session = storage.syntheticValidationSession()
        if (session != null && session.isActive(System.currentTimeMillis())) {
          val validation = transport as? OpenMasuSyntheticValidationTransport
            ?: throw UnsupportedOperationException("synthetic_validation_transport_unsupported")
          validation.deliverForSyntheticValidation(credential, batch, session.token)
          true
        } else if (transport is OpenMasuDiagnosticTransport) {
          transport.deliverWithDiagnostics(credential, batch)
          true
        } else transport.deliver(credential, batch)
      }
    }.getOrDefault(false)) {
      database.runInTransaction {
        for (event in queued) database.queue().deleteDelivered(event.eventId,event.processingSequence,event.consentRevision)
      }
      if (database.queue().count() > 0) backstopScheduler(context)
      true
    } else {
      backstopScheduler(context)
      false
    }
  }

  internal fun pendingCount(): Int = executor.submit<Int> { database.queue().count() }.get()
  internal fun pendingEvents(): List<QueuedEvent> = executor.submit<List<QueuedEvent>> { database.queue().pending(10_000) }.get()
  internal fun installationId(): String = storage.installationId()
  fun queueHealth(): OpenMasuQueueHealth = executor.submit<OpenMasuQueueHealth> { readQueueHealth() }.get()

  /** Local reads only. Completion runs on Room's read executor, never the delivery executor. */
  fun diagnosticsSnapshot(onComplete: (OpenMasuDiagnosticsSnapshot) -> Unit) {
    database.queryExecutor.execute {
      val queue = readQueueHealth()
      val attempt = storage.diagnosticAttempt()
      val enabled = storage.collectionEnabled(defaultCollectionEnabled)
      val barrier = storage.consentBarrierActive()
      val reset = storage.deletionReceipt() != null || storage.resetInstallPending()
      onComplete(OpenMasuDiagnosticsSnapshot(
        enabled, barrier, reset, storage.credential() != null,
        attempt.atMs, attempt.operation, attempt.result, attempt.httpClass,
        when {
          reset -> OpenMasuRetryState.RESET_PENDING
          !enabled -> OpenMasuRetryState.COLLECTION_BLOCKED
          barrier -> OpenMasuRetryState.CONSENT_BLOCKED
          queue.pendingCount > 0 -> OpenMasuRetryState.PENDING
          else -> OpenMasuRetryState.NONE
        }, queue, OpenMasuStorage.CONSENT_PURPOSES.map(storage::consentSnapshot),
      ))
    }
  }

  private fun readQueueHealth(): OpenMasuQueueHealth {
    val stats = database.queue().stats() ?: QueueStats()
    return OpenMasuQueueHealth(
      pendingCount = database.queue().count(),
      logicalBytes = database.queue().logicalBytes(),
      evictedTotal = stats.evictedTotal,
      rejectedTotal = stats.rejectedTotal,
    )
  }
  fun close() {
    executor.shutdown()
    executor.awaitTermination(10, TimeUnit.SECONDS)
    database.close()
  }

  private fun ensureCredential(installationId: String): InstallationCredential = storage.credential()
    ?: observeTransport(OpenMasuDiagnosticOperation.ENROLLMENT) { transport.enroll(installationId) }
      .also { credential -> storage.withConsentLock {
        check(storage.installationId() == installationId && storage.deletionReceipt() == null) { "enrollment_context_changed" }
        storage.setCredential(credential)
      } }

  private fun <T> observeTransport(operation: OpenMasuDiagnosticOperation, work: () -> T): T {
    val attempt = DiagnosticAttempt(System.currentTimeMillis(), operation, OpenMasuDiagnosticResult.IN_FLIGHT)
    runCatching { storage.setDiagnosticAttempt(attempt) }
    try {
      val value = work()
      val http = transport is HmacHttpTransport || (operation == OpenMasuDiagnosticOperation.DELIVERY && transport is OpenMasuDiagnosticTransport)
      val result = when {
        value == false -> OpenMasuDiagnosticResult.CUSTOM_FAILURE
        http && operation == OpenMasuDiagnosticOperation.DELIVERY -> OpenMasuDiagnosticResult.ACCEPTED
        http -> OpenMasuDiagnosticResult.HTTP_RESPONSE
        else -> OpenMasuDiagnosticResult.CUSTOM_SUCCESS
      }
      val httpClass = when {
        !http -> OpenMasuHttpClass.NONE
        value == DeletionStatus.MISSING -> OpenMasuHttpClass.HTTP_4XX
        else -> OpenMasuHttpClass.HTTP_2XX
      }
      runCatching { storage.setDiagnosticAttempt(attempt.copy(result = result, httpClass = httpClass)) }
      return value
    } catch (error: Exception) {
      val failure = error as? OpenMasuTransportFailure
      runCatching { storage.setDiagnosticAttempt(attempt.copy(
        result = failure?.result ?: if (transport is HmacHttpTransport) OpenMasuDiagnosticResult.UNEXPECTED_RESPONSE else OpenMasuDiagnosticResult.CUSTOM_FAILURE,
        httpClass = failure?.httpClass ?: OpenMasuHttpClass.NONE,
      )) }
      throw error
    }
  }

  private fun normalizeDeferred(value: PlayReferrerEvidence): PlayReferrerEvidence {
    if (value.deepLinkValue == null) return value.copy(deferredDeepLinkStatus = value.deferredDeepLinkStatus ?: "absent")
    val clicked = value.referrerClickAtServer?.let { runCatching { Instant.parse(it) }.getOrNull() }
    if (clicked != null && Duration.between(clicked, Instant.now()).seconds > configuration.deferredDeepLinkTtlSeconds) {
      return value.copy(deferredDeepLinkStatus = "expired")
    }
    return value.copy(deferredDeepLinkStatus = value.deferredDeepLinkStatus ?: "delivered")
  }

  private fun submitMeasurement(purpose: String, work: (OpenMasuPurposeConsent, String) -> Unit) {
    val consent = storage.consentSnapshot(purpose)
    val installationId = storage.installationId()
    val revision = measurementRevision.get()
    executor.execute {
      storage.withConsentLock {
        if (!consent.blocked && isCollectionEnabled() && revision == measurementRevision.get() &&
          installationId == storage.installationId() && consent.revision == storage.consentSnapshot(purpose).revision) {
          work(consent,installationId)
        }
      }
      drain()
    }
  }

  private fun enqueueJson(eventName: String, purpose: String, payload: JSONObject, eventId: String? = null,
    consent: OpenMasuPurposeConsent = storage.consentSnapshot(purpose)): Boolean = storage.withConsentLock {
    if (storage.deletionReceipt() != null) return@withConsentLock false
    if (!isCollectionEnabled() && eventName != "consent_changed") return@withConsentLock false
    val current = storage.consentSnapshot(purpose)
    if (consent.blocked || current.blocked || consent.revision != current.revision) return@withConsentLock false
    purgeConsentRequiredQueueIfBlocked()
    val now = EventFactory.canonicalNow()
    database.queue().admit(
      QueuedEvent(eventId ?: EventFactory.newEventId(), eventName, purpose, payload.toString(), now, storage.nextSequence(), System.currentTimeMillis(), consent.revision),
      configuration.maxQueueRecords,
      configuration.maxQueueBytes,
    ).admitted
  }

  private fun purgeConsentRequiredQueueIfBlocked() {
    storage.withConsentLock {
      for (purpose in CONSENT_REQUIRED_PURPOSES) {
        val consent = storage.consentSnapshot(purpose)
        if (consent.blocked) database.queue().deleteByPurposes(listOf(purpose))
        else database.queue().deleteStaleConsent(purpose,consent.revision)
      }
    }
  }

  private fun completePendingResetInstall(installationId: String = storage.installationId()): Boolean {
    if (!storage.resetInstallPending() || storage.consentBarrierActive("attribution") || !isCollectionEnabled()) return true
    return runCatching {
      ensureCredential(installationId)
      val eventId = "event:reset:$installationId"
      val admitted = database.queue().byEventId(eventId) != null || enqueueJson(
        "install", "attribution",
        EventFactory.install(
          installationId, configuration.wrapperVersion ?: configuration.sdkVersion,
          PlayReferrerEvidence("none", "ok"), MetaReferrerEvidence("provider_unavailable"), "identifier_reset",
        ),
        eventId,
      )
      check(admitted) { "reset_install_not_queued" }
      storage.clearResetInstallPending()
      drain()
      true
    }.getOrElse { backstopScheduler(context); false }
  }

  private fun validateCommerceEvent(
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
  ) {
    require(transactionId.matches(IDENTIFIER_PATTERN)) { "transaction_id_invalid" }
    require(amountUnscaled.matches(NONNEGATIVE_UNSCALED_PATTERN)) { "amount_unscaled_invalid" }
    require(amountScale in 0..18) { "amount_scale_invalid" }
    require(currency.matches(CURRENCY_PATTERN)) { "currency_invalid" }
  }

  companion object {
    private const val WORK_NAME = "openmasu-delivery"
    private val CONSENT_REQUIRED_PURPOSES = setOf("attribution", "analytics", "revenue_measurement")
    private val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9._:-]{1,128}$")
    private val NONNEGATIVE_UNSCALED_PATTERN = Regex("^[0-9]+$")
    private val CURRENCY_PATTERN = Regex("^[A-Z]{3}$")

    fun create(
      context: Context,
      configuration: OpenMasuConfiguration,
      transport: OpenMasuTransport = HmacHttpTransport(configuration),
      playReader: PlayReferrerReader = DisabledPlayReferrerReader,
      metaReader: MetaReferrerReader = DisabledMetaReferrerReader,
      backstopScheduler: (Context) -> Unit = ::scheduleBackstop,
    ): OpenMasuSdk = OpenMasuSdk(context.applicationContext, configuration, transport, playReader, metaReader, backstopScheduler)

    fun scheduleBackstop(context: Context) {
      val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
      WorkManager.getInstance(context).enqueueUniqueWork(
        WORK_NAME,
        ExistingWorkPolicy.KEEP,
        OneTimeWorkRequestBuilder<DeliveryWorker>().setConstraints(constraints).build(),
      )
    }

    private fun manifestCollectionDefault(context: Context): Boolean {
      val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      return info.metaData?.getBoolean("dev.openmasu.COLLECTION_ENABLED_DEFAULT", true) ?: true
    }
  }
}

object OpenMasuSdkFactory {
  @JvmStatic
  fun create(context: Context, configuration: OpenMasuConfiguration): OpenMasuSdk =
    OpenMasuSdk.create(context, configuration)

  @JvmStatic
  fun create(
    context: Context,
    configuration: OpenMasuConfiguration,
    playReader: PlayReferrerReader,
    metaReader: MetaReferrerReader,
  ): OpenMasuSdk = OpenMasuSdk.create(
    context = context,
    configuration = configuration,
    playReader = playReader,
    metaReader = metaReader,
  )
}

class DeliveryWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val storage = OpenMasuStorage(applicationContext)
    val configuration = storage.configuration() ?: return Result.success()
    val sdk = OpenMasuSdk.create(applicationContext, configuration)
    return if (sdk.drain()) Result.success() else Result.retry()
  }
}
