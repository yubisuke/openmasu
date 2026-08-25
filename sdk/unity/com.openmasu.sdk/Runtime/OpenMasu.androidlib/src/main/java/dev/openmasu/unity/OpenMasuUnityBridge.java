package dev.openmasu.unity;

import android.app.Activity;
import dev.openmasu.sdk.OpenMasuConfiguration;
import dev.openmasu.sdk.OpenMasuSdk;
import dev.openmasu.sdk.OpenMasuSdkFactory;
import dev.openmasu.sdk.max.OpenMasuMaxBridge;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import android.content.Intent;
import android.net.Uri;

public final class OpenMasuUnityBridge {
  public interface StringCallback { void onResult(String value); }
  public interface BooleanCallback { void onResult(boolean value); }
  private static volatile OpenMasuSdk sdk;
  private static volatile StringCallback deepLinkCallback;

  private OpenMasuUnityBridge() {}

  public static void initialize(Activity activity, String endpoint, String keyId, String secret, String wrapperVersion,
      String deepLinkHosts, String deepLinkSchemes) {
    OpenMasuConfiguration configuration = new OpenMasuConfiguration(
        endpoint, keyId, secret, "0.1.0", wrapperVersion, 10_000,
        csvSet(deepLinkHosts), csvSet(deepLinkSchemes), 604_800);
    sdk = OpenMasuSdkFactory.create(activity.getApplicationContext(), configuration);
    sdk.setDeepLinkListener(value -> {
      StringCallback callback = deepLinkCallback;
      if (callback != null) callback.onResult(encodeDeepLink(value));
    });
    sdk.initialize();
  }

  public static void trackCustomEvent(String eventKey) {
    requireSdk().trackCustomEvent(eventKey, Collections.emptyMap());
  }

  public static void trackPurchase(String transactionId, String amountUnscaled, int amountScale, String currency) {
    requireSdk().trackPurchase(transactionId, amountUnscaled, amountScale, currency);
  }

  public static void trackRefund(String transactionId, String originalTransactionId, String amountUnscaled,
      int amountScale, String currency) {
    requireSdk().trackRefund(transactionId, originalTransactionId, amountUnscaled, amountScale, currency);
  }

  public static void startSession() { requireSdk().startSession(); }

  public static void setCollectionEnabled(boolean enabled) { requireSdk().setCollectionEnabled(enabled); }

  public static void resetInstallationId(BooleanCallback callback) {
    requireSdk().resetInstallationId(value -> { callback.onResult(value); return kotlin.Unit.INSTANCE; });
  }

  public static void pingFromBackground(String value, StringCallback callback) {
    new Thread(() -> callback.onResult(value), "openmasu-unity-callback").start();
  }

  public static void setDeepLinkListener(StringCallback callback) { deepLinkCallback = callback; }

  public static void handleDeepLink(Activity activity, String url) {
    requireSdk().handleDeepLink(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
  }

  private static String encodeDeepLink(dev.openmasu.sdk.OpenMasuDeepLink value) {
    StringBuilder result = new StringBuilder();
    append(result, "value", value.getValue());
    append(result, "open_source", value.getOpenSource());
    append(result, "destination_status", value.getDestinationStatus());
    append(result, "link_slug", value.getLinkSlug());
    for (java.util.Map.Entry<String, String> item : value.getParameters().entrySet()) append(result, "p_" + item.getKey(), item.getValue());
    return result.toString();
  }

  private static void append(StringBuilder result, String key, String value) {
    if (value == null) return;
    if (result.length() > 0) result.append('&');
    result.append(URLEncoder.encode(key, StandardCharsets.UTF_8));
    result.append('=').append(URLEncoder.encode(value, StandardCharsets.UTF_8));
  }

  private static Set<String> csvSet(String value) {
    if (value == null || value.trim().isEmpty()) return Collections.emptySet();
    Set<String> result = new HashSet<>();
    for (String item : value.split(",")) if (!item.trim().isEmpty()) result.add(item.trim());
    return result;
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
