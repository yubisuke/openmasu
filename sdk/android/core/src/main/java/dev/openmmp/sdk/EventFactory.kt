package dev.openmmp.sdk

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

internal object EventFactory {
  private val canonicalFormatter = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
  fun canonicalNow(): String = canonicalFormatter.format(Instant.ofEpochMilli(System.currentTimeMillis()))

  fun install(
    installationId: String,
    sdkVersion: String,
    play: PlayReferrerEvidence,
    meta: MetaReferrerEvidence,
    origin: String,
  ): JSONObject = JSONObject()
    .put("event_name", "install")
    .put("installation_id", installationId)
    .put("install_type", "first_install")
    .put("install_origin", origin)
    .put("referrer_status", play.status)
    .put("referrer_client_response", play.clientResponse)
    .put("install_begin_at_server_status", if (play.installBeginAtServer == null) "missing" else "available")
    .put("sdk_version", sdkVersion)
    .putOpt("click_id", play.clickId)
    .putOpt("referrer_click_at_device", play.referrerClickAtDevice)
    .putOpt("referrer_click_at_server", play.referrerClickAtServer)
    .putOpt("install_begin_at_device", play.installBeginAtDevice)
    .putOpt("install_begin_at_server", play.installBeginAtServer)
    .put("meta_referrer_status", if (meta.status == "decrypt_pending") "decrypt_failed" else meta.status)
    .put("extensions", JSONObject().apply {
      meta.installReferrer?.let { put("meta_install_referrer_protected", it) }
      meta.isCt?.let { put("meta_is_ct_unverified", it) }
      meta.actualTimestamp?.let { put("meta_actual_timestamp_unverified", it) }
      meta.providerAuthority?.let { put("meta_provider_authority", it) }
      play.referrer?.let { put("play_install_referrer_protected", it) }
      play.installVersion?.let { put("install_version", it) }
    })

  fun custom(installationId: String, eventKey: String, attributes: Map<String, Any?>): JSONObject =
    JSONObject().put("event_name", "custom_event").put("installation_id", installationId)
      .put("event_key", eventKey).put("attributes", JSONObject(attributes))

  fun session(installationId: String, sessionId: String): JSONObject = JSONObject()
    .put("event_name", "session_start")
    .put("installation_id", installationId)
    .put("session_id", sessionId)

  fun consent(state: String, policyVersion: String): JSONObject = JSONObject()
    .put("event_name", "consent_changed")
    .put("consent_state", state)
    .put("effective_at", canonicalNow())
    .put("consent_policy_version", policyVersion)

  fun envelope(events: List<QueuedEvent>, producerVersion: String, wrapperVersion: String?): String =
    JSONObject().put("records", JSONArray(events.map { event ->
      JSONObject()
        .put("event_id", event.eventId)
        .put("event_name", event.eventName)
        .put("occurred_at", event.occurredAt)
        .put("occurred_at_source", "device")
        .put("processing_purpose_id", event.processingPurposeId)
        .put("processing_sequence", event.processingSequence)
        .put("producer_version", producerVersion)
        .putOpt("wrapper_version", wrapperVersion)
        .put("payload", JSONObject(event.payloadJson))
    })).toString()

  fun newEventId(): String = "event:${UUID.randomUUID()}"
  fun newSessionId(): String = "session:${UUID.randomUUID()}"
}
