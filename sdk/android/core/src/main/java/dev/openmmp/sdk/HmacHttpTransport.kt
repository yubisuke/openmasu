package dev.openmmp.sdk

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.UUID

class HmacHttpTransport(private val configuration: OpenMmpConfiguration) : OpenMmpTransport {
  override fun enroll(installationId: String): InstallationCredential {
    val response = request("/v1/installations", JSONObject().put("installation_id", installationId).toString(), null)
    check(response.status == 201) { "installation_enrollment_failed:${response.status}" }
    val value = JSONObject(response.body)
    return InstallationCredential(value.getString("installation_key_id"), value.getString("installation_secret"))
  }

  override fun deliver(credential: InstallationCredential, events: List<QueuedEvent>): Boolean =
    request("/v1/events/batch", EventFactory.envelope(events, configuration.sdkVersion, configuration.wrapperVersion), credential).status == 202

  override fun deleteInstallation(credential: InstallationCredential, installationId: String): Boolean =
    request("/v1/privacy/installation", JSONObject().put("installation_id", installationId).toString(), credential).status == 201

  private fun request(path: String, body: String, credential: InstallationCredential?): Response {
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
    connection.setRequestProperty("x-openmmp-sdk-key-id", configuration.sdkKeyId)
    if (credential != null) connection.setRequestProperty("x-openmmp-installation-key-id", credential.keyId)
    connection.setRequestProperty("x-openmmp-timestamp-ms", timestamp)
    connection.setRequestProperty("x-openmmp-nonce", nonce)
    connection.setRequestProperty("x-openmmp-signature", signature)
    connection.outputStream.use { it.write(bytes) }
    val status = connection.responseCode
    val stream = if (status in 200..399) connection.inputStream else connection.errorStream
    return Response(status, stream?.bufferedReader()?.use { it.readText() }.orEmpty())
  }

  private data class Response(val status: Int, val body: String)
}
