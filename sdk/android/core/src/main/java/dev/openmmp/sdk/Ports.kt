package dev.openmmp.sdk

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

interface OpenMmpTransport {
  fun enroll(installationId: String): InstallationCredential
  fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean
  fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean
}

internal object DisabledPlayReferrerReader : PlayReferrerReader {
  override fun read() = PlayReferrerEvidence("unavailable", "service_unavailable")
}

internal object DisabledMetaReferrerReader : MetaReferrerReader {
  override fun read() = MetaReferrerEvidence("provider_unavailable")
}
