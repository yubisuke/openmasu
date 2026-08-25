package dev.openmmp.sdk.max

import com.applovin.mediation.MaxAd
import com.applovin.mediation.MaxAdRevenueListener
import dev.openmmp.sdk.OpenMmpSdk
import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

data class MaxRevenueObservation(
  val revenue: Double,
  val precision: String,
  val networkName: String,
  val adUnitId: String,
  val placement: String? = null,
  val networkPlacement: String? = null,
  val format: String = "unknown",
)

class MaxRevenueMapper(
  private val installationId: () -> String,
  private val impressionId: () -> String = { "impression:${UuidV7.generate()}" },
) {
  val errorCount = AtomicLong(0)

  fun map(observation: MaxRevenueObservation): JSONObject? {
    if (!observation.revenue.isFinite() || observation.revenue < 0.0) {
      errorCount.incrementAndGet()
      return null
    }
    val precision = observation.precision.takeIf { it in PRECISIONS }
    if (precision == null) {
      errorCount.incrementAndGet()
      return null
    }
    val micros = BigDecimal.valueOf(observation.revenue)
      .movePointRight(6)
      .setScale(0, RoundingMode.HALF_EVEN)
      .toPlainString()
    return JSONObject()
      .put("event_name", "ad_revenue")
      .put("subject_scope", "installation_level")
      .put("installation_id", installationId())
      .put("impression_id", impressionId())
      .put("ad_unit_id", observation.adUnitId)
      .put("ad_network", observation.networkName)
      .put("mediation_provider", "applovin-max")
      .put("amount_unscaled", micros)
      .put("amount_scale", 6)
      .put("currency", "USD")
      .put("currency_source", "reported")
      .put("revenue_source", "client_estimated")
      .put("revenue_precision", precision)
      .put("extensions", JSONObject().apply {
        put("ad_format", observation.format)
        observation.placement?.let { put("placement", it) }
        observation.networkPlacement?.let { put("network_placement", it) }
      })
  }

  private companion object {
    val PRECISIONS = setOf("publisher_defined", "exact", "estimated", "undefined")
  }
}

class OpenMmpMaxRevenueListener(
  private val sdk: OpenMmpSdk,
  private val mapper: MaxRevenueMapper,
) : MaxAdRevenueListener {
  override fun onAdRevenuePaid(ad: MaxAd) {
    mapper.map(
      MaxRevenueObservation(
        revenue = ad.revenue,
        precision = ad.revenuePrecision,
        networkName = ad.networkName,
        adUnitId = ad.adUnitId,
        placement = ad.placement,
        networkPlacement = ad.networkPlacement,
        format = ad.format.label,
      ),
    )?.let { payload -> sdk.enqueueAdRevenue(payload, payload.getString("impression_id")) }
  }
}

object OpenMmpMaxBridge {
  @JvmStatic
  fun listener(sdk: OpenMmpSdk): OpenMmpMaxRevenueListener =
    OpenMmpMaxRevenueListener(sdk, MaxRevenueMapper(sdk::installationIdForMeasurement))

  @JvmStatic
  fun track(
    sdk: OpenMmpSdk,
    revenue: Double,
    precision: String,
    networkName: String,
    adUnitId: String,
    placement: String?,
    networkPlacement: String?,
  ): Boolean {
    val payload = MaxRevenueMapper(sdk::installationIdForMeasurement).map(
      MaxRevenueObservation(revenue, precision, networkName, adUnitId, placement, networkPlacement),
    ) ?: return false
    sdk.enqueueAdRevenue(payload, payload.getString("impression_id"))
    return true
  }
}

private object UuidV7 {
  private val random = SecureRandom()

  fun generate(nowMs: Long = System.currentTimeMillis()): UUID {
    val bytes = ByteArray(16).also(random::nextBytes)
    for (index in 0 until 6) bytes[index] = ((nowMs ushr ((5 - index) * 8)) and 0xff).toByte()
    bytes[6] = ((bytes[6].toInt() and 0x0f) or 0x70).toByte()
    bytes[8] = ((bytes[8].toInt() and 0x3f) or 0x80).toByte()
    var most = 0L
    var least = 0L
    for (index in 0 until 8) most = (most shl 8) or (bytes[index].toLong() and 0xff)
    for (index in 8 until 16) least = (least shl 8) or (bytes[index].toLong() and 0xff)
    return UUID(most, least)
  }
}
