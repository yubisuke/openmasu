package dev.openmmp.unity;

import android.app.Activity;
import dev.openmmp.sdk.OpenMmpConfiguration;
import dev.openmmp.sdk.OpenMmpSdk;
import dev.openmmp.sdk.OpenMmpSdkFactory;
import dev.openmmp.sdk.max.OpenMmpMaxBridge;
import java.util.Collections;

public final class OpenMmpUnityBridge {
  public interface StringCallback { void onResult(String value); }
  public interface BooleanCallback { void onResult(boolean value); }
  private static volatile OpenMmpSdk sdk;

  private OpenMmpUnityBridge() {}

  public static void initialize(Activity activity, String endpoint, String keyId, String secret, String wrapperVersion) {
    OpenMmpConfiguration configuration = new OpenMmpConfiguration(endpoint, keyId, secret, "0.1.0", wrapperVersion, 10_000);
    sdk = OpenMmpSdkFactory.create(activity.getApplicationContext(), configuration);
    sdk.initialize();
  }

  public static void trackCustomEvent(String eventKey) {
    requireSdk().trackCustomEvent(eventKey, Collections.emptyMap());
  }

  public static void startSession() { requireSdk().startSession(); }

  public static void setCollectionEnabled(boolean enabled) { requireSdk().setCollectionEnabled(enabled); }

  public static void resetInstallationId(BooleanCallback callback) {
    requireSdk().resetInstallationId(value -> { callback.onResult(value); return kotlin.Unit.INSTANCE; });
  }

  public static void pingFromBackground(String value, StringCallback callback) {
    new Thread(() -> callback.onResult(value), "openmmp-unity-callback").start();
  }

  public static boolean trackMaxRevenue(double revenue, String precision, String networkName,
      String adUnitId, String placement, String networkPlacement) {
    return OpenMmpMaxBridge.track(requireSdk(), revenue, precision, networkName, adUnitId, placement, networkPlacement);
  }

  private static OpenMmpSdk requireSdk() {
    OpenMmpSdk value = sdk;
    if (value == null) throw new IllegalStateException("Open MMP is not initialized");
    return value;
  }
}
