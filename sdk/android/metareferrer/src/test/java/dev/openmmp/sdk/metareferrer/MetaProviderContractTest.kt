package dev.openmmp.sdk.metareferrer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class MetaProviderContractTest {
  @Test fun `provider package and authority strings exactly match the primary contract`() {
    assertEquals(listOf("com.facebook.katana", "com.instagram.android", "com.facebook.lite"), MetaProviderContract.PACKAGES)
    assertEquals(
      listOf(
        "com.facebook.katana.provider.InstallReferrerProvider",
        "com.instagram.contentprovider.InstallReferrerProvider",
        "com.facebook.lite.provider.InstallReferrerProvider",
      ),
      MetaProviderContract.AUTHORITIES,
    )
    assertArrayEquals(arrayOf("install_referrer", "is_ct", "actual_timestamp"), MetaProviderContract.PROJECTION)
  }
}
