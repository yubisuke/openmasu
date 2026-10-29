package dev.openmasu.sdk

data class PlayReferrerEvidence(
  val status: String,
  val clientResponse: String,
  val clickId: String? = null,
  val referrer: String? = null,
  val referrerClickAtDevice: String? = null,
  val referrerClickAtServer: String? = null,
  val installBeginAtDevice: String? = null,
  val installBeginAtServer: String? = null,
  val installVersion: String? = null,
  val deepLinkValue: String? = null,
  val deepLinkParameters: Map<String, String> = emptyMap(),
  val deferredDeepLinkStatus: String? = null,
  val shouldRetry: Boolean = false,
)

fun interface PlayReferrerReader {
  fun read(): PlayReferrerEvidence
}

data class MetaReferrerEvidence(
  val status: String,
  val installReferrer: String? = null,
  val isCt: Int? = null,
  val actualTimestamp: Long? = null,
  val providerAuthority: String? = null,
)

fun interface MetaReferrerReader {
  fun read(): MetaReferrerEvidence
}

interface OpenMasuTransport {
  fun enroll(installationId: String): InstallationCredential
  fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean
  fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean
}

enum class OpenMasuDiagnosticOperation { NONE, ENROLLMENT, DELIVERY, DELETION, DELETION_STATUS }
enum class OpenMasuDiagnosticResult {
  NOT_ATTEMPTED, IN_FLIGHT, ACCEPTED, HTTP_RESPONSE, AUTHENTICATION_REJECTED, RATE_LIMITED,
  NETWORK_UNAVAILABLE, SERVER_ERROR, REQUEST_REJECTED, UNEXPECTED_RESPONSE, CUSTOM_SUCCESS, CUSTOM_FAILURE,
}
enum class OpenMasuHttpClass { NONE, HTTP_2XX, HTTP_4XX, HTTP_5XX, OTHER }
enum class OpenMasuRetryState { NONE, PENDING, COLLECTION_BLOCKED, CONSENT_BLOCKED, RESET_PENDING }

/** Closed local metadata only. ACCEPTED means HTTP admission, never ledger completion. */
data class OpenMasuDiagnosticsSnapshot(
  val collectionEnabled: Boolean,
  val consentBarrierActive: Boolean,
  val resetPending: Boolean,
  val enrolled: Boolean,
  val lastAttemptAtMs: Long?,
  val lastOperation: OpenMasuDiagnosticOperation,
  val lastResult: OpenMasuDiagnosticResult,
  val httpClass: OpenMasuHttpClass,
  val retryState: OpenMasuRetryState,
  val queue: OpenMasuQueueHealth,
)

/** Optional transport capability; legacy Boolean transports need no changes. */
interface OpenMasuDiagnosticTransport : OpenMasuTransport {
  /** Return only after HTTP 202 admission; failures must use closed typed errors. */
  fun deliverWithDiagnostics(credential: InstallationCredential, events: List<QueuedEvent>)
}

/** No URL, payload, response body, or underlying exception message is retained. */
class OpenMasuTransportFailure private constructor(
  val result: OpenMasuDiagnosticResult,
  val httpClass: OpenMasuHttpClass,
) : Exception("openmasu_transport_failure") {
  companion object {
    fun http(status: Int): OpenMasuTransportFailure = OpenMasuTransportFailure(
      when (status) {
        401, 403 -> OpenMasuDiagnosticResult.AUTHENTICATION_REJECTED
        429 -> OpenMasuDiagnosticResult.RATE_LIMITED
        in 500..599 -> OpenMasuDiagnosticResult.SERVER_ERROR
        in 400..499 -> OpenMasuDiagnosticResult.REQUEST_REJECTED
        else -> OpenMasuDiagnosticResult.UNEXPECTED_RESPONSE
      },
      when (status) {
        in 200..299 -> OpenMasuHttpClass.HTTP_2XX
        in 400..499 -> OpenMasuHttpClass.HTTP_4XX
        in 500..599 -> OpenMasuHttpClass.HTTP_5XX
        else -> OpenMasuHttpClass.OTHER
      },
    )
    fun networkUnavailable() = OpenMasuTransportFailure(OpenMasuDiagnosticResult.NETWORK_UNAVAILABLE, OpenMasuHttpClass.NONE)
  }
}

internal data class DiagnosticAttempt(
  val atMs: Long? = null,
  val operation: OpenMasuDiagnosticOperation = OpenMasuDiagnosticOperation.NONE,
  val result: OpenMasuDiagnosticResult = OpenMasuDiagnosticResult.NOT_ATTEMPTED,
  val httpClass: OpenMasuHttpClass = OpenMasuHttpClass.NONE,
)

enum class DeletionStatus { MISSING, PROCESSING, COMPLETED }

/** Optional capability; legacy custom transports retain synchronous deletion semantics. */
interface OpenMasuDeletionTransport : OpenMasuTransport {
  fun beginDeletion(credential: InstallationCredential, installationId: String, receipt: String): DeletionStatus
  fun deletionStatus(receipt: String): DeletionStatus
}

internal object DisabledPlayReferrerReader : PlayReferrerReader {
  override fun read() = PlayReferrerEvidence("unavailable", "service_unavailable")
}

internal object DisabledMetaReferrerReader : MetaReferrerReader {
  override fun read() = MetaReferrerEvidence("provider_unavailable")
}
