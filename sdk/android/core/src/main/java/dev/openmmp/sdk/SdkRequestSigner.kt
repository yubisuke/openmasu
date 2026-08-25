package dev.openmmp.sdk

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object SdkRequestSigner {
  fun canonical(
    method: String,
    path: String,
    sdkKeyId: String,
    installationKeyId: String?,
    timestampMs: Long,
    nonce: String,
    body: ByteArray,
  ): String = listOf(
    "open-mmp-sdk-v1",
    method.uppercase(),
    path,
    sdkKeyId,
    installationKeyId ?: "-",
    timestampMs.toString(),
    nonce,
    sha256(body),
  ).joinToString("\n")

  fun sign(secret: String, canonical: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return mac.doFinal(canonical.toByteArray(Charsets.UTF_8)).toHex()
  }

  fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(value).toHex()

  private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
}
