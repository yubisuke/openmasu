package dev.openmmp.sdk.installreferrer

import android.content.Context
import android.util.Log
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import com.android.installreferrer.api.ReferrerDetails
import dev.openmmp.sdk.PlayReferrerEvidence
import dev.openmmp.sdk.PlayReferrerReader
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class GooglePlayReferrerReader(
  context: Context,
  private val timeoutSeconds: Long = 5,
) : PlayReferrerReader {
  private val client = InstallReferrerClient.newBuilder(context.applicationContext).build()

  override fun read(): PlayReferrerEvidence {
    val latch = CountDownLatch(1)
    var result = PlayReferrerEvidence("unavailable", "service_disconnected", shouldRetry = true)
    client.startConnection(object : InstallReferrerStateListener {
      override fun onInstallReferrerSetupFinished(responseCode: Int) {
        result = when (responseCode) {
          InstallReferrerClient.InstallReferrerResponse.OK -> runCatching { details(client.installReferrer) }
            .getOrElse { PlayReferrerEvidence("unavailable", "service_unavailable", shouldRetry = true) }
          InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED ->
            PlayReferrerEvidence("unsupported", "feature_not_supported")
          InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE ->
            PlayReferrerEvidence("unavailable", "service_unavailable", shouldRetry = true)
          InstallReferrerClient.InstallReferrerResponse.DEVELOPER_ERROR -> {
            Log.e(TAG, "Install Referrer returned DEVELOPER_ERROR; verify the Play integration")
            PlayReferrerEvidence("unavailable", "developer_error")
          }
          InstallReferrerClient.InstallReferrerResponse.SERVICE_DISCONNECTED ->
            PlayReferrerEvidence("unavailable", "service_disconnected", shouldRetry = true)
          else -> PlayReferrerEvidence("unavailable", "service_unavailable", shouldRetry = true)
        }
        client.endConnection()
        latch.countDown()
      }

      override fun onInstallReferrerServiceDisconnected() {
        result = PlayReferrerEvidence("unavailable", "service_disconnected", shouldRetry = true)
        latch.countDown()
      }
    })
    if (!latch.await(timeoutSeconds, TimeUnit.SECONDS)) {
      client.endConnection()
      return PlayReferrerEvidence("unavailable", "service_disconnected", shouldRetry = true)
    }
    return result
  }

  /**
   * This method intentionally calls every accessor backed by the seven fields in
   * the Play Install Referrer 2.2 response Bundle. Compilation is acceptance A-09b.
   */
  internal fun details(value: ReferrerDetails): PlayReferrerEvidence {
    val referrer = value.installReferrer
    val clickDevice = value.referrerClickTimestampSeconds
    val installDevice = value.installBeginTimestampSeconds
    val instant = value.googlePlayInstantParam
    val clickServer = value.referrerClickTimestampServerSeconds
    val installServer = value.installBeginTimestampServerSeconds
    val installVersion = value.installVersion
    val clickId = referrer.split('&').mapNotNull { field ->
      val pair = field.split('=', limit = 2)
      if (pair.size == 2 && pair[0] == "cid") URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name()) else null
    }.firstOrNull()
    val status = if (referrer.isBlank()) "none" else if (clickId == null) "third_party" else "available"
    return PlayReferrerEvidence(
      status = status,
      clientResponse = "ok",
      clickId = clickId,
      referrer = referrer.ifBlank { null },
      referrerClickAtDevice = epochSeconds(clickDevice),
      referrerClickAtServer = epochSeconds(clickServer),
      installBeginAtDevice = epochSeconds(installDevice),
      installBeginAtServer = epochSeconds(installServer),
      installVersion = installVersion + if (instant) "+instant" else "",
    )
  }

  private fun epochSeconds(value: Long): String? = if (value <= 0L) null else CANONICAL_FORMATTER.format(Instant.ofEpochSecond(value))

  private companion object {
    const val TAG = "OpenMmpReferrer"
    val CANONICAL_FORMATTER = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
  }
}
