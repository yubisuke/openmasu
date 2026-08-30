package dev.openmasu.unity;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import dev.openmasu.sdk.MetaReferrerReader;
import dev.openmasu.sdk.PlayReferrerReader;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

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

  @Test public void invalidMetaAppIdFailsClosed() {
    MetaReferrerReader meta = OpenMasuUnityBridge.createMetaReferrerReader(
        context.getContentResolver(), "invalid/app/id");
    assertEquals("provider_unavailable", meta.read().getStatus());
  }

  @Test public void linkHostsAreNormalizedBeforeManifestComparison() {
    assertEquals(
        OpenMasuUnityBridge.csvHostSet("a.synthetic.example,b.synthetic.example"),
        OpenMasuUnityBridge.csvHostSet(" B.SYNTHETIC.EXAMPLE., a.synthetic.example, a.synthetic.example "));
  }

  @Test public void runtimeAndManifestLinkHostsMustMatchExactly() {
    OpenMasuUnityBridge.requireLinkHostsMatch(
        OpenMasuUnityBridge.csvHostSet("a.synthetic.example,b.synthetic.example"),
        OpenMasuUnityBridge.csvHostSet("b.synthetic.example,a.synthetic.example"));

    IllegalStateException error = assertThrows(IllegalStateException.class, () ->
        OpenMasuUnityBridge.requireLinkHostsMatch(
            OpenMasuUnityBridge.csvHostSet("a.synthetic.example,b.synthetic.example"),
            OpenMasuUnityBridge.csvHostSet("a.synthetic.example")));
    assertEquals("deep_link_hosts_manifest_mismatch", error.getMessage());
  }

  @Test public void maxRevenueBridgeKeepsLegacyAndFormatAwareOverloads() throws Exception {
    assertNotNull(OpenMasuUnityBridge.class.getMethod(
        "trackMaxRevenue", double.class, String.class, String.class, String.class, String.class, String.class));
    assertNotNull(OpenMasuUnityBridge.class.getMethod(
        "trackMaxRevenue", double.class, String.class, String.class, String.class, String.class, String.class,
        String.class));
  }
}
