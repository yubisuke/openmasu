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
      if (storage.consentBarrierActive()) {
        drain()
        return@execute
      }
      if (storage.resetInstallPending()) {
        completePendingResetInstall()
        return@execute
      }
      val installationId = storage.installationId()
      if (!storage.referrerConsumed()) {
        val play = normalizeDeferred(playReader.read())
        val meta = metaReader.read()
        enqueueJson("install", "attribution", EventFactory.install(installationId, configuration.wrapperVersion ?: configuration.sdkVersion, play, meta, "play_first_launch"))
        val deferred = DeepLinkParser.fromReferrer(play)
        if (deferred != null && !storage.deferredDestinationConsumed()) {
          deepLinkListener?.onDeepLink(deferred)
          enqueueJson("deep_link_open", "attribution", EventFactory.deepLink(installationId, deferred))
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
    executor.execute {
      enqueueJson("custom_event", "analytics", EventFactory.custom(storage.installationId(), eventKey, attributes))
      drain()
    }
  }

  fun startSession() {
    if (!isCollectionEnabled()) return
    executor.execute {
      enqueueJson("session_start", "analytics", EventFactory.session(storage.installationId(), EventFactory.newSessionId()))
      drain()
    }
  }

  fun setDeepLinkListener(listener: OpenMasuDeepLinkListener?) {
    deepLinkListener = listener
  }

  fun handleDeepLink(intent: Intent): Boolean {
    val value = DeepLinkParser.direct(intent, configuration.deepLinkHosts, configuration.deepLinkSchemes) ?: return false
    deepLinkListener?.onDeepLink(value)
    if (isCollectionEnabled()) executor.execute {
      enqueueJson("deep_link_open", "attribution", EventFactory.deepLink(storage.installationId(), value))
      drain()
    }
    return true
  }

  @JvmOverloads
  fun enqueueAdRevenue(payload: JSONObject, eventId: String? = null) {
    if (!isCollectionEnabled()) return
    executor.execute { enqueueJson("ad_revenue", "revenue_measurement", payload, eventId); drain() }
  }

  fun trackPurchase(
    transactionId: String,
    amountUnscaled: String,
    amountScale: Int,
    currency: String,
  ) {
    if (!isCollectionEnabled()) return
    validateCommerceEvent(transactionId, amountUnscaled, amountScale, currency)
    executor.execute {
      val installationId = storage.installationId()
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
      )
      drain()
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
    val installationId = storage.installationId()
    try {
      executor.execute {
        val result = runCatching {
          when {
            storage.deletionReceipt() != null && measurementRevision.get() != revision -> OpenMasuPurchaseQueueResult.CONTEXT_CHANGED
            !isCollectionEnabled() -> OpenMasuPurchaseQueueResult.COLLECTION_DISABLED
            storage.consentBarrierActive() -> OpenMasuPurchaseQueueResult.CONSENT_REQUIRED
            storage.installationId() != installationId -> OpenMasuPurchaseQueueResult.INSTALLATION_CHANGED
            measurementRevision.get() != revision -> OpenMasuPurchaseQueueResult.CONTEXT_CHANGED
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
    executor.execute {
      val installationId = storage.installationId()
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
      )
      drain()
    }
  }

  fun installationIdForMeasurement(): String = storage.installationId()
  fun flushBlocking(timeoutMs: Long = 10_000): Boolean =
    executor.submit<Boolean> { drain() }.get(timeoutMs, TimeUnit.MILLISECONDS)

  @JvmOverloads
  fun updateConsent(state: String, policyVersion: String, onComplete: ((Boolean) -> Unit)? = null) {
    require(state in setOf("granted", "denied", "withdrawn", "not_required", "unknown"))
    if (state == "denied" || state == "withdrawn") measurementRevision.incrementAndGet()
    storage.applyConsentState(state)
    try {
      executor.execute {
        val updated = runCatching {
          var admitted = false
          database.runInTransaction {
            purgeConsentRequiredQueueIfBlocked()
            admitted = enqueueJson("consent_changed", "fraud_prevention", EventFactory.consent(state, policyVersion))
          }
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

  @JvmOverloads
  fun resetInstallationId(onComplete: (Boolean) -> Unit = {}) {
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
    if (storage.resetInstallPending() && !storage.consentBarrierActive()) return completePendingResetInstall()
    purgeConsentRequiredQueueIfBlocked()
    val batch = database.queue().pending(100)
    if (batch.isEmpty()) return true
    val credential = runCatching { storage.credential() ?: ensureCredential(storage.installationId()) }
      .getOrElse { backstopScheduler(context); return false }
    return if (runCatching {
      observeTransport(OpenMasuDiagnosticOperation.DELIVERY) {
        if (transport is OpenMasuDiagnosticTransport) {
          transport.deliverWithDiagnostics(credential, batch)
          true
        } else transport.deliver(credential, batch)
      }
    }.getOrDefault(false)) {
      database.queue().deleteByIds(batch.map { it.eventId })
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
        }, queue,
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
      .also { storage.setCredential(it) }

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

  private fun enqueueJson(eventName: String, purpose: String, payload: JSONObject, eventId: String? = null): Boolean {
    if (storage.deletionReceipt() != null) return false
    if (!isCollectionEnabled() && eventName != "consent_changed") return false
    if (storage.consentBarrierActive() && purpose in CONSENT_REQUIRED_PURPOSES) return false
    val now = EventFactory.canonicalNow()
    return database.queue().admit(
      QueuedEvent(eventId ?: EventFactory.newEventId(), eventName, purpose, payload.toString(), now, storage.nextSequence(), System.currentTimeMillis()),
      configuration.maxQueueRecords,
      configuration.maxQueueBytes,
    ).admitted
  }

  private fun purgeConsentRequiredQueueIfBlocked() {
    if (storage.consentBarrierActive()) database.queue().deleteByPurposes(CONSENT_REQUIRED_PURPOSES.toList())
  }

  private fun completePendingResetInstall(installationId: String = storage.installationId()): Boolean {
    if (!storage.resetInstallPending() || storage.consentBarrierActive() || !isCollectionEnabled()) return true
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
