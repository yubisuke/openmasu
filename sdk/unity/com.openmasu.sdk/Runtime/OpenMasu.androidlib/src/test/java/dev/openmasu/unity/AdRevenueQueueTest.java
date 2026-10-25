package dev.openmasu.unity;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import dev.openmasu.sdk.*;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
public final class AdRevenueQueueTest {
  @Test public void callbackObservationsSurviveRoomReopenAndDeliverOnlyThreeImpressions() throws Exception {
    Context context = ApplicationProvider.getApplicationContext();
    context.getSharedPreferences("openmasu_private", Context.MODE_PRIVATE).edit().clear().commit();
    String endpoint = System.getenv("OPENMASU_LEVELPLAY_ENDPOINT");
    String input = System.getenv("OPENMASU_LEVELPLAY_INPUT");
    if (endpoint != null) {
      assertTrue(endpoint.matches("http://127\\.0\\.0\\.1:[0-9]+"));
      assertNotNull("the journey must consume actual managed callback observations", input);
    }
    OpenMasuConfiguration configuration = new OpenMasuConfiguration(
        endpoint == null ? "https://synthetic.invalid" : endpoint,
        endpoint == null ? "synthetic-sdk" : System.getenv("OPENMASU_LEVELPLAY_KEY_ID"),
        endpoint == null ? "synthetic-secret" : System.getenv("OPENMASU_LEVELPLAY_SECRET"));
    AtomicBoolean deliver = new AtomicBoolean(false);
    AtomicReference<List<QueuedEvent>> captured = new AtomicReference<>();
    HmacHttpTransport http = endpoint == null ? null : new HmacHttpTransport(configuration);
    OpenMasuTransport transport = new OpenMasuTransport() {
      public InstallationCredential enroll(String installation) {
        return http == null ? new InstallationCredential("synthetic-key", "synthetic-secret") : http.enroll(installation);
      }
      public boolean deliver(InstallationCredential credential, List<QueuedEvent> events) {
        captured.set(new java.util.ArrayList<>(events));
        return deliver.get() && (http == null || http.deliver(credential, events));
      }
      public boolean deleteInstallation(InstallationCredential credential, String installation) { return false; }
    };
    Field field = OpenMasuUnityBridge.class.getDeclaredField("sdk"); field.setAccessible(true);
    OpenMasuSdk sdk = make(context, configuration, transport);
    try {
      field.set(null, sdk);
      sdk.initialize(); sdk.updateConsent("granted", "synthetic-levelplay"); sdk.flushBlocking(10_000L);
      JSONArray observations = input == null ? syntheticObservations() : new JSONArray(
          new String(Files.readAllBytes(java.nio.file.Paths.get(input)), java.nio.charset.StandardCharsets.UTF_8));
      assertEquals(4, observations.length());
      for (int index = 0; index < observations.length(); index++) {
        JSONObject value = observations.getJSONObject(index);
        OpenMasuUnityBridge.trackAdRevenue(value.getString("ImpressionId"), value.getString("AmountUnscaled"),
            value.getString("RevenuePrecision"), value.getString("AdNetwork"), value.getString("AdUnitId"),
            value.getString("MediationProvider"), value.getString("AdFormat"));
      }
      sdk.flushBlocking(10_000L);
      sdk.close();
      // Reopen the actual Room database, not an in-memory capture of calls.
      sdk = make(context, configuration, transport); field.set(null, sdk);
      captured.set(null); sdk.flushBlocking(10_000L);
      List<QueuedEvent> pending = captured.get(); assertNotNull(pending);
      List<QueuedEvent> revenue = pending.stream().filter(value -> value.getEventName().equals("ad_revenue"))
          .collect(java.util.stream.Collectors.toList());
      assertEquals(3, revenue.size());
      long total = 0;
      for (QueuedEvent event : revenue) {
        JSONObject payload = new JSONObject(event.getPayloadJson());
        assertEquals(event.getEventId(), payload.getString("impression_id"));
        assertEquals("unity-levelplay", payload.getString("mediation_provider"));
        assertEquals("client_estimated", payload.getString("revenue_source"));
        assertEquals("USD", payload.getString("currency"));
        total += Long.parseLong(payload.getString("amount_unscaled"));
      }
      assertEquals(2_000_000L, total);
      deliver.set(true); assertTrue(sdk.flushBlocking(10_000L));
      assertEquals(0, sdk.queueHealth().getPendingCount());
    } finally { sdk.close(); field.set(null, null); }
  }

  @Test public void invalidNativeArgumentsAndWithdrawalCannotQueueRevenue() throws Exception {
    assertThrows(IllegalArgumentException.class, () -> OpenMasuUnityBridge.adRevenuePayload(
        "installation:synthetic", "invalid", "0", "exact", "synthetic", "synthetic", "unity-levelplay", "banner"));
    for (String amount : new String[] { "", "NaN", "-1", "1.2", "01" })
      assertThrows(IllegalArgumentException.class, () -> OpenMasuUnityBridge.adRevenuePayload(
          "installation:synthetic", "impression:" + "a".repeat(64), amount, "exact", "synthetic", "synthetic", "unity-levelplay", "banner"));
    Context context = ApplicationProvider.getApplicationContext();
    context.getSharedPreferences("openmasu_private", Context.MODE_PRIVATE).edit().clear().commit();
    OpenMasuTransport offline = new OpenMasuTransport() {
      public InstallationCredential enroll(String id) { return new InstallationCredential("synthetic", "synthetic"); }
      public boolean deliver(InstallationCredential key, List<QueuedEvent> events) { return false; }
      public boolean deleteInstallation(InstallationCredential key, String id) { return false; }
    };
    OpenMasuSdk sdk = make(context, new OpenMasuConfiguration("https://synthetic.invalid", "synthetic", "synthetic"), offline);
    Field field = OpenMasuUnityBridge.class.getDeclaredField("sdk"); field.setAccessible(true); field.set(null, sdk);
    try {
      sdk.initialize(); sdk.updateConsent("withdrawn", "synthetic-levelplay");
      OpenMasuUnityBridge.trackAdRevenue("impression:" + "a".repeat(64), "1000000", "exact", "synthetic", "synthetic", "unity-levelplay", "banner");
      sdk.flushBlocking(10_000L);
      assertEquals(1, sdk.queueHealth().getPendingCount()); // Only the privacy control event.
    } finally { sdk.close(); field.set(null, null); }
  }

  private static OpenMasuSdk make(Context context, OpenMasuConfiguration configuration, OpenMasuTransport transport) {
    return OpenMasuSdk.Companion.create(context, configuration, transport,
        OpenMasuUnityBridge.createPlayReferrerReader(context, false),
        OpenMasuUnityBridge.createMetaReferrerReader(context.getContentResolver(), ""),
        ignored -> kotlin.Unit.INSTANCE);
  }

  private static JSONArray syntheticObservations() throws Exception {
    JSONArray values = new JSONArray();
    for (int index = 0; index < 3; index++) values.put(new JSONObject()
        .put("ImpressionId", "impression:" + new String[] {"a", "b", "c"}[index].repeat(64))
        .put("AmountUnscaled", new String[] {"1250000", "500000", "250000"}[index])
        .put("RevenuePrecision", new String[] {"exact", "publisher_defined", "estimated"}[index])
        .put("AdNetwork", "synthetic-ad-network").put("AdUnitId", "synthetic-unit-" + index)
        .put("MediationProvider", "unity-levelplay").put("AdFormat", new String[] {"rewarded", "interstitial", "banner"}[index]));
    values.put(values.getJSONObject(0)); return values;
  }
}
