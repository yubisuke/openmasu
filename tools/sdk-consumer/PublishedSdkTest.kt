package dev.openmasu.consumer

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.openmasu.sdk.OpenMasuConfiguration
import dev.openmasu.sdk.OpenMasuSdk
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Uses only the downloaded public SDK: real Room storage and default HTTP/HMAC. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PublishedSdkTest {
  @Test(timeout = 90_000)
  fun publishedCoreDeliversNativeEvents() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val configuration = OpenMasuConfiguration(
      endpoint = requiredEnvironment("OPENMASU_SYNTHETIC_SDK_ENDPOINT"),
      sdkKeyId = requiredEnvironment("OPENMASU_SYNTHETIC_SDK_KEY_ID"),
      sdkSecret = requiredEnvironment("OPENMASU_SYNTHETIC_SDK_SECRET"),
      timeoutMs = 5_000,
    )
    // Do not replace transport/readers or override the artifact's embedded version.
    val sdk = OpenMasuSdk.create(context, configuration, backstopScheduler = {})
    val installationId: String
    try {
      assertTrue("The default manifest must enable collection", sdk.isCollectionEnabled())
      assertEquals("The new consumer must start with an empty queue", 0, sdk.queueHealth().pendingCount)
      val consentAdmitted = AtomicBoolean(false)
      sdk.updateConsent("granted", "synthetic-published-sdk-policy") { consentAdmitted.set(it) }
      sdk.initialize()
      sdk.startSession()
      sdk.trackCustomEvent("published_sdk_consumer", mapOf("source" to "synthetic_published_sdk"))
      sdk.trackPurchase("synthetic-published-sdk-purchase", "250", 2, "USD")

      // This task runs on the same FIFO executor after every asynchronous SDK call.
      assertTrue("Real HTTP delivery must succeed", sdk.flushBlocking(60_000))
      assertTrue("The consent control event must have been admitted", consentAdmitted.get())
      val health = sdk.queueHealth()
      assertEquals("Every queued event must be acknowledged", 0, health.pendingCount)
      assertEquals("The drained queue must have no logical payload bytes", 0L, health.logicalBytes)
      assertEquals("No event may be silently evicted", 0L, health.evictedTotal)
      assertEquals("No event may be silently rejected", 0L, health.rejectedTotal)
      assertTrue("The native persistent Room queue must exist", context.filesDir.resolve("openmasu/queue.db").isFile)
      installationId = sdk.installationIdForMeasurement()
      assertTrue("The SDK must create an installation identity", installationId.startsWith("installation:"))
    } finally {
      sdk.close()
    }

    // Reopen the actual consumer's storage, without creating extra events.
    val reopened = OpenMasuSdk.create(context, configuration, backstopScheduler = {})
    try {
      assertTrue("The installation identity must persist", installationId == reopened.installationIdForMeasurement())
      assertEquals("The drained queue must remain empty after reopening", 0, reopened.queueHealth().pendingCount)
    } finally {
      reopened.close()
    }
  }

  private fun requiredEnvironment(name: String): String =
    checkNotNull(System.getenv(name)?.takeIf { it.isNotBlank() }) { "Synthetic test configuration is missing" }
}
