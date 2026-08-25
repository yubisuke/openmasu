package dev.openmasu.sdk.metareferrer

import android.content.ContentResolver
import android.net.Uri
import dev.openmasu.sdk.MetaReferrerEvidence
import dev.openmasu.sdk.MetaReferrerReader

object MetaProviderContract {
  val PACKAGES: List<String> = listOf(
    "com.facebook.katana",
    "com.instagram.android",
    "com.facebook.lite",
  )
  val AUTHORITIES: List<String> = listOf(
    "com.facebook.katana.provider.InstallReferrerProvider",
    "com.instagram.contentprovider.InstallReferrerProvider",
    "com.facebook.lite.provider.InstallReferrerProvider",
  )
  val PROJECTION: Array<String> = arrayOf("install_referrer", "is_ct", "actual_timestamp")
}

class MetaInstallReferrerReader(
  private val resolver: ContentResolver,
  private val facebookAppId: String,
) : MetaReferrerReader {
  override fun read(): MetaReferrerEvidence {
    for (authority in MetaProviderContract.AUTHORITIES) {
      val cursor = runCatching {
        resolver.query(
          Uri.parse("content://$authority/$facebookAppId"),
          MetaProviderContract.PROJECTION,
          null,
          null,
          null,
        )
      }.getOrNull() ?: continue
      cursor.use {
        if (!it.moveToFirst()) continue
        val installReferrer = it.stringOrNull("install_referrer")
        if (installReferrer.isNullOrBlank()) return MetaReferrerEvidence("no_campaign_data", providerAuthority = authority)
        return MetaReferrerEvidence(
          status = "decrypt_pending",
          installReferrer = installReferrer,
          isCt = it.stringOrNull("is_ct")?.toIntOrNull()?.takeIf { value -> value == 0 || value == 1 },
          actualTimestamp = it.stringOrNull("actual_timestamp")?.toLongOrNull()?.takeIf { value -> value >= 0L },
          providerAuthority = authority,
        )
      }
    }
    return MetaReferrerEvidence("provider_unavailable")
  }

  private fun android.database.Cursor.stringOrNull(name: String): String? {
    val index = getColumnIndex(name)
    return if (index < 0 || isNull(index)) null else getString(index)
  }
}
