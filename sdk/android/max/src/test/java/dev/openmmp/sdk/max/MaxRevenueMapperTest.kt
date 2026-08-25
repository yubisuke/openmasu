package dev.openmmp.sdk.max

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class MaxRevenueMapperTest {
  private val mapper = MaxRevenueMapper({ "installation:synthetic" }, { "impression:synthetic" })

  @Test fun `maps every documented precision and rounds USD to micros with half even`() {
    for (precision in listOf("exact", "estimated", "publisher_defined", "undefined")) {
      val payload = mapper.map(MaxRevenueObservation(0.0000025, precision, "Synthetic Network", "ad-unit:synthetic"))!!
      assertEquals("2", payload.getString("amount_unscaled"))
      assertEquals(6, payload.getInt("amount_scale"))
      assertEquals("USD", payload.getString("currency"))
      assertEquals(precision, payload.getString("revenue_precision"))
      assertEquals("installation_level", payload.getString("subject_scope"))
      assertEquals("client_estimated", payload.getString("revenue_source"))
      assertEquals("applovin-max", payload.getString("mediation_provider"))
    }
    val upperTie = mapper.map(MaxRevenueObservation(0.0000035, "exact", "Synthetic", "ad-unit:synthetic"))!!
    assertEquals("4", upperTie.getString("amount_unscaled"))
  }

  @Test fun `drops error sentinel and non-finite or undocumented values`() {
    assertNull(mapper.map(MaxRevenueObservation(-1.0, "exact", "Synthetic", "ad-unit:synthetic")))
    assertNull(mapper.map(MaxRevenueObservation(Double.NaN, "exact", "Synthetic", "ad-unit:synthetic")))
    assertNull(mapper.map(MaxRevenueObservation(0.1, "", "Synthetic", "ad-unit:synthetic")))
    assertEquals(3L, mapper.errorCount.get())
  }

  @Test fun `default impression identifier is UUIDv7`() {
    val payload = MaxRevenueMapper({ "installation:synthetic" }).map(
      MaxRevenueObservation(0.0, "undefined", "Synthetic", "ad-unit:synthetic"),
    )!!
    val uuid = UUID.fromString(payload.getString("impression_id").removePrefix("impression:"))
    assertEquals(7, uuid.version())
    assertEquals(2, uuid.variant())
  }

  @Test fun `M4 A29 matches the shared Android and Swift mapping vectors`() {
    val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
      .first { File(it, "sdk/max-revenue-mapping-vectors.json").isFile }
    val fixture = JSONObject(File(root, "sdk/max-revenue-mapping-vectors.json").readText())
    val vectors = fixture.getJSONArray("vectors")
    for (index in 0 until vectors.length()) {
      val vector = vectors.getJSONObject(index)
      val input = vector.getJSONObject("input")
      val payload = MaxRevenueMapper(
        { vector.getString("installation_id") },
        { vector.getString("impression_id") },
      ).map(MaxRevenueObservation(
        input.getDouble("revenue"), input.getString("precision"), input.getString("network_name"),
        input.getString("ad_unit_id"), input.optString("placement").takeIf(String::isNotEmpty),
        input.optString("network_placement").takeIf(String::isNotEmpty),
        input.getString("format"),
      ))
      assertEquals(canonical(vector.getJSONObject("expected_payload")), canonical(payload!!))
    }
  }

  private fun canonical(value: Any?): String = when (value) {
    is JSONObject -> value.keys().asSequence().toList().sorted()
      .joinToString(prefix = "{", postfix = "}") { key -> "${JSONObject.quote(key)}:${canonical(value.get(key))}" }
    is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    JSONObject.NULL, null -> "null"
    else -> value.toString()
  }
}
