package dev.openmasu.sdk

import android.content.Context
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

data class OpenMasuConfiguration(
  val endpoint: String,
  val sdkKeyId: String,
  val sdkSecret: String,
  val sdkVersion: String = OpenMasuStorage.SDK_VERSION,
  val wrapperVersion: String? = null,
  val timeoutMs: Int = 10_000,
)

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
  private val defaultCollectionEnabled = manifestCollectionDefault(context)

  fun initialize() {
    if (!initialized.compareAndSet(false, true)) return
    storage.persistConfiguration(configuration)
    if (!isCollectionEnabled()) return
    executor.execute {
      val installationId = storage.installationId()
      if (!storage.referrerConsumed()) {
        val play = playReader.read()
        val meta = metaReader.read()
        enqueueJson("install", "attribution", EventFactory.install(installationId, configuration.wrapperVersion ?: configuration.sdkVersion, play, meta, "play_first_launch"))
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

  @JvmOverloads
  fun enqueueAdRevenue(payload: JSONObject, eventId: String? = null) {
    if (!isCollectionEnabled()) return
    executor.execute { enqueueJson("ad_revenue", "revenue_measurement", payload, eventId); drain() }
  }

  fun installationIdForMeasurement(): String = storage.installationId()
  fun flushBlocking(timeoutMs: Long = 10_000): Boolean =
    executor.submit<Boolean> { drain() }.get(timeoutMs, TimeUnit.MILLISECONDS)

  fun updateConsent(state: String, policyVersion: String) {
    require(state in setOf("granted", "denied", "withdrawn", "not_required", "unknown"))
    executor.execute {
      database.runInTransaction {
        if (state == "withdrawn" || state == "denied") {
          database.queue().deleteByPurposes(listOf("attribution", "analytics", "revenue_measurement"))
        }
        enqueueJson("consent_changed", "fraud_prevention", EventFactory.consent(state, policyVersion))
      }
      if (isCollectionEnabled()) drain()
    }
  }

  fun setCollectionEnabled(enabled: Boolean) {
    storage.setCollectionEnabled(enabled)
    if (enabled) executor.execute { drain() }
  }

  fun isCollectionEnabled(): Boolean = storage.collectionEnabled(defaultCollectionEnabled)

  @JvmOverloads
  fun resetInstallationId(onComplete: (Boolean) -> Unit = {}) {
    executor.execute {
      val oldId = storage.installationId()
      val credential = storage.credential()
      if (credential == null || !transport.deleteInstallation(credential, oldId)) {
        onComplete(false)
        return@execute
      }
      database.runInTransaction { database.queue().deleteAll() }
      storage.clearAfterDeletion()
      val newId = storage.replaceInstallationId()
      ensureCredential(newId)
      enqueueJson(
        "install", "attribution",
        EventFactory.install(
          newId, configuration.wrapperVersion ?: configuration.sdkVersion,
          PlayReferrerEvidence("none", "ok"), MetaReferrerEvidence("provider_unavailable"), "identifier_reset",
        ),
      )
      drain()
      onComplete(true)
    }
  }

  internal fun drain(): Boolean {
    if (!isCollectionEnabled()) return false
    val credential = runCatching { storage.credential() ?: ensureCredential(storage.installationId()) }
      .getOrElse { backstopScheduler(context); return false }
    val batch = database.queue().pending(100)
    if (batch.isEmpty()) return true
    return if (runCatching { transport.deliver(credential, batch) }.getOrDefault(false)) {
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
  fun close() {
    executor.shutdown()
    executor.awaitTermination(10, TimeUnit.SECONDS)
    database.close()
  }

  private fun ensureCredential(installationId: String): InstallationCredential = storage.credential()
    ?: transport.enroll(installationId).also { storage.setCredential(it) }

  private fun enqueueJson(eventName: String, purpose: String, payload: JSONObject, eventId: String? = null) {
    if (!isCollectionEnabled() && eventName != "consent_changed") return
    val now = EventFactory.canonicalNow()
    database.queue().insert(
      QueuedEvent(eventId ?: EventFactory.newEventId(), eventName, purpose, payload.toString(), now, storage.nextSequence(), System.currentTimeMillis()),
    )
  }

  companion object {
    private const val WORK_NAME = "openmasu-delivery"

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
}

class DeliveryWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  override fun doWork(): Result {
    val storage = OpenMasuStorage(applicationContext)
    val configuration = storage.configuration() ?: return Result.success()
    val sdk = OpenMasuSdk.create(applicationContext, configuration)
    return if (sdk.drain()) Result.success() else Result.retry()
  }
}
