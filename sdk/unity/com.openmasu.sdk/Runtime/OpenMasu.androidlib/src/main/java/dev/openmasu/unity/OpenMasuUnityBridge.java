package dev.openmasu.unity;

import android.app.Activity;
import dev.openmasu.sdk.OpenMasuConfiguration;
import dev.openmasu.sdk.OpenMasuSdk;
import dev.openmasu.sdk.OpenMasuSdkFactory;
import dev.openmasu.sdk.max.OpenMasuMaxBridge;
import java.util.Collections;

public final class OpenMasuUnityBridge {
  public interface StringCallback { void onResult(String value); }
  public interface BooleanCallback { void onResult(boolean value); }
  private static volatile OpenMasuSdk sdk;

  private OpenMasuUnityBridge() {}

  public static void initialize(Activity activity, String endpoint, String keyId, String secret, String wrapperVersion) {
    OpenMasuConfiguration configuration = new OpenMasuConfiguration(endpoint, keyId, secret, "0.1.0", wrapperVersion, 10_000);
    sdk = OpenMasuSdkFactory.create(activity.getApplicationContext(), configuration);
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
    new Thread(() -> callback.onResult(value), "openmasu-unity-callback").start();
  }

  public static boolean trackMaxRevenue(double revenue, String precision, String networkName,
      String adUnitId, String placement, String networkPlacement) {
    return OpenMasuMaxBridge.track(requireSdk(), revenue, precision, networkName, adUnitId, placement, networkPlacement);
  }

  private static OpenMasuSdk requireSdk() {
    OpenMasuSdk value = sdk;
    if (value == null) throw new IllegalStateException("OpenMasu is not initialized");
    return value;
  }
}
