package dev.openmasu.sdk

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.UUID

class HmacHttpTransport(private val configuration: OpenMasuConfiguration) : OpenMasuDeletionTransport, OpenMasuSyntheticValidationTransport, OpenMasuPrivacyTransport {
  override fun privacyPage(credential: InstallationCredential, installationId: String,
    requestType: OpenMasuPrivacyRequestType, cursor: String?, pageSize: Int): String {
    require(OpenMasuPrivacyPage.validRequest(cursor, pageSize))
    val body = JSONObject().put("installation_id", installationId).put("request_type", requestType.wire)
      .put("pagination", "cursor_v1").put("page_size", pageSize)
    if (cursor != null) body.put("cursor", cursor)
    val response = request("/v1/privacy/access", body.toString(), credential, maxBytes = OpenMasuPrivacyPage.MAX_BYTES)
    if (response.status != 200) throw OpenMasuTransportFailure.http(response.status)
    return response.body
  }
  override fun enroll(installationId: String): InstallationCredential {
    val response = request("/v1/installations", JSONObject().put("installation_id", installationId).toString(), null)
    if (response.status != 201) throw OpenMasuTransportFailure.http(response.status)
    val value = JSONObject(response.body)
    return InstallationCredential(value.getString("installation_key_id"), value.getString("installation_secret"))
  }

  override fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean =
    request("/v1/events/batch", EventFactory.envelope(events, configuration.sdkVersion, configuration.wrapperVersion), credential).status == 202

  override fun deliverWithDiagnostics(credential: InstallationCredential, events: List<QueuedEvent>) {
    val status = request("/v1/events/batch", EventFactory.envelope(events, configuration.sdkVersion, configuration.wrapperVersion), credential).status
    if (status != 202) throw OpenMasuTransportFailure.http(status)
  }

  override fun deliverForSyntheticValidation(credential: InstallationCredential, events: List<QueuedEvent>, sessionToken: String) {
    require(SyntheticValidationSession.validToken(sessionToken)) { "synthetic_validation_token_invalid" }
    val body = JSONObject(EventFactory.envelope(events, configuration.sdkVersion, configuration.wrapperVersion))
      .put("validation_session_token", sessionToken).toString()
    val status = request("/v1/events/batch", body, credential).status
    if (status != 202) throw OpenMasuTransportFailure.http(status)
  }

  override fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean =
    request("/v1/privacy/installation", JSONObject().put("installation_id", installationId).toString(), credential).status == 201

  override fun beginDeletion(credential: InstallationCredential, installationId: String, receipt: String): DeletionStatus {
    val response = request("/v1/privacy/installation", JSONObject().put("installation_id", installationId)
      .put("status_receipt", receipt).toString(), credential)
    if (response.status != 201 && response.status != 202) throw OpenMasuTransportFailure.http(response.status)
    return parseDeletionStatus(response)
  }

  override fun deletionStatus(receipt: String): DeletionStatus {
    val response = request("/v1/privacy/installation/status", JSONObject().put("status_receipt", receipt).toString(), null, false)
    if (response.status == 404) return DeletionStatus.MISSING
    if (response.status != 200) throw OpenMasuTransportFailure.http(response.status)
    return parseDeletionStatus(response)
  }

  private fun parseDeletionStatus(response: Response): DeletionStatus = when (JSONObject(response.body).getString("status")) {
    "completed" -> DeletionStatus.COMPLETED
    "processing" -> DeletionStatus.PROCESSING
    else -> error("deletion_response_invalid")
  }

  private fun request(path: String, body: String, credential: InstallationCredential?, authenticated: Boolean = true, maxBytes: Int? = null): Response {
    val bytes = body.toByteArray(Charsets.UTF_8)
    val timestamp = System.currentTimeMillis().toString()
    val nonce = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(18).also { java.security.SecureRandom().nextBytes(it) })
    val installationKeyId = credential?.keyId ?: "-"
    val signing = SdkRequestSigner.canonical(
      "POST", path, configuration.sdkKeyId, installationKeyId.takeUnless { it == "-" },
      timestamp.toLong(), nonce, bytes,
    )
    val secret = credential?.secret ?: configuration.sdkSecret
    val signature = SdkRequestSigner.sign(secret, signing)
    val connection = URL(configuration.endpoint.trimEnd('/') + path).openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.doOutput = true
    connection.connectTimeout = configuration.timeoutMs
    connection.readTimeout = configuration.timeoutMs
    connection.setRequestProperty("content-type", "application/json")
    if (authenticated) {
      connection.setRequestProperty("x-openmasu-sdk-key-id", configuration.sdkKeyId)
      if (credential != null) connection.setRequestProperty("x-openmasu-installation-key-id", credential.keyId)
      connection.setRequestProperty("x-openmasu-timestamp-ms", timestamp)
      connection.setRequestProperty("x-openmasu-nonce", nonce)
      connection.setRequestProperty("x-openmasu-signature", signature)
    }
    try {
      connection.outputStream.use { it.write(bytes) }
      val status = connection.responseCode
      val stream = if (status in 200..399) connection.inputStream else connection.errorStream
      val text = if (maxBytes == null) stream?.bufferedReader()?.use { it.readText() }.orEmpty() else stream?.use {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val read = it.read(buffer)
          if (read < 0) break
          require(output.size() + read <= maxBytes) { "privacy_response_too_large" }
          output.write(buffer, 0, read)
        }
        output.toString("UTF-8")
      }.orEmpty()
      return Response(status, text)
    } catch (_: java.io.IOException) {
      throw OpenMasuTransportFailure.networkUnavailable()
    } finally {
      connection.disconnect()
    }
  }

  private data class Response(val status: Int, val body: String)
}
