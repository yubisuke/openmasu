package dev.openmasu.unity;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import dev.openmasu.sdk.MetaReferrerReader;
import dev.openmasu.sdk.PlayReferrerReader;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import static org.junit.Assert.assertEquals;

@RunWith(RobolectricTestRunner.class)
public final class OpenMasuUnityBridgeTest {
  private final Context context = ApplicationProvider.getApplicationContext();

  @Test public void standardUnityPathSelectsGoogleAndConfiguredMetaReaders() {
    PlayReferrerReader play = OpenMasuUnityBridge.createPlayReferrerReader(context, true);
    MetaReferrerReader meta = OpenMasuUnityBridge.createMetaReferrerReader(
        context.getContentResolver(), "synthetic-app-id");

    assertEquals(
        "dev.openmasu.sdk.installreferrer.GooglePlayReferrerReader",
        play.getClass().getName());
    assertEquals(
        "dev.openmasu.sdk.metareferrer.MetaInstallReferrerReader",
        meta.getClass().getName());
  }

  @Test public void disabledOrUnconfiguredProvidersFailClosed() {
    PlayReferrerReader play = OpenMasuUnityBridge.createPlayReferrerReader(context, false);
    MetaReferrerReader meta = OpenMasuUnityBridge.createMetaReferrerReader(
        context.getContentResolver(), "  ");

    assertEquals("unavailable", play.read().getStatus());
    assertEquals("service_unavailable", play.read().getClientResponse());
    assertEquals("provider_unavailable", meta.read().getStatus());
  }
}
