package dev.openmasu.sdk

import org.json.JSONObject

enum class OpenMasuPrivacyRequestType(val wire: String) { ACCESS("access"), PORTABILITY("portability") }
enum class OpenMasuPrivacyResultStatus {
  PAGE_READY, COMPLETE, RESET_PENDING, CONTEXT_CHANGED, NOT_ENROLLED, UNSUPPORTED, INVALID_REQUEST, REQUEST_FAILED,
}

/** Optional capability; no changes are required in existing custom transports. */
interface OpenMasuPrivacyTransport : OpenMasuTransport {
  fun privacyPage(credential: InstallationCredential, installationId: String, requestType: OpenMasuPrivacyRequestType,
    cursor: String?, pageSize: Int): String
}

/** Sensitive, transient data. Save/share only at the host user's explicit request. */
class OpenMasuPrivacyPage private constructor(
  val payloadJson: String, val requestId: String, val cutoffAt: String, val nextCursor: String?,
  val complete: Boolean, val returnedCount: Int,
) {
  override fun toString() = "OpenMasuPrivacyPage(redacted)"
  companion object {
    const val MAX_BYTES = 262144
    internal fun validRequest(cursor: String?, pageSize: Int) = pageSize in 1..500 &&
      (cursor == null || cursor.matches(Regex("^[A-Za-z0-9_-]{1,16384}$")))
    internal fun parse(json: String, requestType: OpenMasuPrivacyRequestType, pageSize: Int): OpenMasuPrivacyPage {
      require(json.toByteArray(Charsets.UTF_8).size <= MAX_BYTES)
      val value = JSONObject(json)
      require(value.getString("dsar_response_version") == "internal-v2" && value.getString("request_type") == requestType.wire)
      val complete = value.get("complete") as? Boolean ?: error("privacy_response_invalid")
      val cursor = if (value.isNull("next_cursor")) null else value.getString("next_cursor")
      require(value.has("next_cursor") && complete == (cursor == null) && validRequest(cursor, pageSize))
      val count = value.getJSONArray("records").length() + value.getJSONArray("attributions").length() +
        value.getJSONArray("verified_commerce_lifecycle").length()
      require(count <= pageSize && value.getInt("returned_count") == count && value.getInt("page_size") == pageSize)
      val id = value.getString("request_id"); val cutoff = value.getString("cutoff_at")
      require(id.isNotEmpty() && id.length <= 128 && cutoff.length in 20..40)
      return OpenMasuPrivacyPage(json, id, cutoff, cursor, complete, count)
    }
  }
}

class OpenMasuPrivacyResult(val status: OpenMasuPrivacyResultStatus, val page: OpenMasuPrivacyPage? = null) {
  override fun toString() = "OpenMasuPrivacyResult($status)"
  /** Internal native bridge framing; never send this value to logs or analytics. */
  fun bridgeValue(): String = status.name.lowercase() + "\n" + (page?.payloadJson ?: "")
}
