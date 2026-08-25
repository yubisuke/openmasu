package dev.openmasu.sdk

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class SdkRequestSignerTest {
  @Test fun `M4 A20 matches shared signing vectors`() {
    val root = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
      .first { File(it, "sdk/signing-vectors.json").isFile }
    val vectors = JSONObject(File(root, "sdk/signing-vectors.json").readText()).getJSONArray("vectors")
    for (index in 0 until vectors.length()) {
      val vector = vectors.getJSONObject(index)
      val installationKeyId = vector.getString("installation_key_id").takeUnless { it == "-" }
      val canonical = SdkRequestSigner.canonical(
        vector.getString("method"), vector.getString("path"), vector.getString("sdk_key_id"),
        installationKeyId, vector.getLong("timestamp_ms"), vector.getString("nonce"),
        vector.getString("body").toByteArray(Charsets.UTF_8),
      )
      assertEquals(vector.getString("canonical"), canonical)
      assertEquals(vector.getString("body_sha256"), SdkRequestSigner.sha256(vector.getString("body").toByteArray()))
      assertEquals(vector.getString("signature"), SdkRequestSigner.sign(vector.getString("secret"), canonical))
    }
  }
}
