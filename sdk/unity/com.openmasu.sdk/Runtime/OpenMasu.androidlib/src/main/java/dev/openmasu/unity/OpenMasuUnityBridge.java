package dev.openmasu.unity;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import dev.openmasu.sdk.OpenMasuConfiguration;
import dev.openmasu.sdk.MetaReferrerEvidence;
import dev.openmasu.sdk.MetaReferrerReader;
import dev.openmasu.sdk.OpenMasuSdk;
import dev.openmasu.sdk.OpenMasuSdkFactory;
import dev.openmasu.sdk.OpenMasuQueueHealth;
import dev.openmasu.sdk.OpenMasuPurchaseQueueResult;
import dev.openmasu.sdk.PlayReferrerEvidence;
import dev.openmasu.sdk.PlayReferrerReader;
import dev.openmasu.sdk.max.OpenMasuMaxBridge;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.lang.reflect.Constructor;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import android.content.Intent;
import android.net.Uri;

public final class OpenMasuUnityBridge {
  public interface StringCallback { void onResult(String value); }
  public interface BooleanCallback { void onResult(boolean value); }
  static final String LINK_HOSTS_METADATA_NAME = "dev.openmasu.sdk.LINK_HOSTS";
  private static volatile OpenMasuSdk sdk;
  private static volatile StringCallback deepLinkCallback;

  private OpenMasuUnityBridge() {}

  public static void initialize(Activity activity, String endpoint, String keyId, String secret, String wrapperVersion,
      String deepLinkHosts, String deepLinkSchemes) {
    initialize(activity, endpoint, keyId, secret, wrapperVersion, deepLinkHosts, deepLinkSchemes, false, "");
  }

  public static void initialize(Activity activity, String endpoint, String keyId, String secret, String wrapperVersion,
      String deepLinkHosts, String deepLinkSchemes, boolean enablePlayReferrer, String metaAppId) {
    Context context = activity.getApplicationContext();
    Set<String> configuredLinkHosts = csvHostSet(deepLinkHosts);
    requireLinkHostsMatch(configuredLinkHosts, manifestLinkHosts(context));
    OpenMasuConfiguration configuration = new OpenMasuConfiguration(
        endpoint, keyId, secret, "0.3.0-rc.2", wrapperVersion, 10_000,
        configuredLinkHosts, csvSet(deepLinkSchemes), 604_800);
    sdk = OpenMasuSdkFactory.create(
        context,
        configuration,
        createPlayReferrerReader(context, enablePlayReferrer),
        createMetaReferrerReader(context.getContentResolver(), metaAppId));
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

  public static void trackGooglePlayProductPurchase(String purchaseToken, String productId, String transactionId,
      String amountUnscaled, int amountScale, String currency, StringCallback callback) {
    trackGooglePlayPurchase(false, purchaseToken, productId, transactionId, amountUnscaled, amountScale,
        currency, callback);
  }

  public static void trackGooglePlaySubscriptionPurchase(String purchaseToken, String productId, String transactionId,
      String amountUnscaled, int amountScale, String currency, StringCallback callback) {
    trackGooglePlayPurchase(true, purchaseToken, productId, transactionId, amountUnscaled, amountScale,
        currency, callback);
  }

  private static void trackGooglePlayPurchase(boolean subscription, String purchaseToken, String productId,
      String transactionId, String amountUnscaled, int amountScale, String currency, StringCallback callback) {
    if (callback == null) throw new IllegalArgumentException("callback_required");
    OpenMasuSdk current = sdk;
    if (current == null) {
      callback.onResult("state=not_submitted&error=not_initialized");
      return;
    }
    kotlin.jvm.functions.Function1<OpenMasuPurchaseQueueResult, kotlin.Unit> completed = result -> {
      callback.onResult(purchaseResult(result));
      return kotlin.Unit.INSTANCE;
    };
    try {
      if (subscription) {
        current.trackGooglePlaySubscriptionPurchase(
            purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency, completed);
      } else {
        current.trackGooglePlayProductPurchase(
            purchaseToken, productId, transactionId, amountUnscaled, amountScale, currency, completed);
      }
    } catch (IllegalArgumentException exception) {
      callback.onResult("state=not_submitted&error=invalid_arguments");
    } catch (RuntimeException exception) {
      callback.onResult("state=not_submitted&error=native_failure");
    }
  }

  static String purchaseResult(OpenMasuPurchaseQueueResult result) {
    if (result == OpenMasuPurchaseQueueResult.QUEUED) return "state=queued";
    return "state=not_submitted&error=" + result.name().toLowerCase(Locale.ROOT);
  }

  public static void updateConsent(String state, String policyVersion, StringCallback callback) {
    if (callback == null) throw new IllegalArgumentException("callback_required");
    OpenMasuSdk current = sdk;
    if (current == null) {
      callback.onResult("state=not_submitted&error=not_initialized");
      return;
    }
    try {
      current.updateConsent(state, policyVersion, updated -> {
        callback.onResult(updated ? "state=updated" : "state=not_submitted&error=native_failure");
        return kotlin.Unit.INSTANCE;
      });
    } catch (IllegalArgumentException exception) {
      callback.onResult("state=not_submitted&error=invalid_arguments");
    } catch (RuntimeException exception) {
      callback.onResult("state=not_submitted&error=native_failure");
    }
  }

  public static void trackRefund(String transactionId, String originalTransactionId, String amountUnscaled,
      int amountScale, String currency) {
    requireSdk().trackRefund(transactionId, originalTransactionId, amountUnscaled, amountScale, currency);
  }

  public static void startSession() { requireSdk().startSession(); }

  public static void getQueueHealth(StringCallback callback) {
    new Thread(() -> {
      OpenMasuQueueHealth health = requireSdk().queueHealth();
      callback.onResult(
          "pending_count=" + health.getPendingCount() +
          "&logical_bytes=" + health.getLogicalBytes() +
          "&evicted_total=" + health.getEvictedTotal() +
          "&rejected_total=" + health.getRejectedTotal());
    }, "openmasu-queue-health").start();
  }

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

  static Set<String> csvHostSet(String value) {
    if (value == null || value.trim().isEmpty()) return Collections.emptySet();
    Set<String> result = new HashSet<>();
    for (String item : value.split(",")) {
      String normalized = item.trim().toLowerCase(Locale.ROOT);
      while (normalized.endsWith(".")) normalized = normalized.substring(0, normalized.length() - 1);
      if (!normalized.isEmpty()) result.add(normalized);
    }
    return result;
  }

  static void requireLinkHostsMatch(Set<String> configured, Set<String> manifest) {
    if (!configured.equals(manifest)) throw new IllegalStateException("deep_link_hosts_manifest_mismatch");
  }

  static Set<String> manifestLinkHosts(Context context) {
    try {
      ApplicationInfo info = context.getPackageManager().getApplicationInfo(
          context.getPackageName(), PackageManager.GET_META_DATA);
      String value = info.metaData == null ? null : info.metaData.getString(LINK_HOSTS_METADATA_NAME);
      return csvHostSet(value);
    } catch (PackageManager.NameNotFoundException exception) {
      throw new IllegalStateException("deep_link_manifest_unavailable", exception);
    }
  }

  public static void trackAdRevenue(String impressionId, String amountUnscaled, String precision,
      String network, String adUnitId, String mediationProvider, String format) {
    OpenMasuSdk current = requireSdk();
    current.enqueueAdRevenue(adRevenuePayload(current.installationIdForMeasurement(), impressionId,
        amountUnscaled, precision, network, adUnitId, mediationProvider, format), impressionId);
  }

  static org.json.JSONObject adRevenuePayload(String installationId, String impressionId,
      String amountUnscaled, String precision, String network, String adUnitId,
      String mediationProvider, String format) {
    if (impressionId == null || !impressionId.matches("impression:[a-f0-9]{64}")
        || amountUnscaled == null || !amountUnscaled.matches("0|[1-9][0-9]{0,28}")
        || precision == null || !precision.matches("exact|estimated|publisher_defined|undefined")
        || network == null || network.trim().isEmpty() || network.length() > 128
        || adUnitId == null || !adUnitId.matches("[A-Za-z0-9._:-]{1,128}")
        || mediationProvider == null || !mediationProvider.matches("[A-Za-z0-9._:-]{1,128}")
        || format == null || !format.matches("rewarded|interstitial|banner|unknown"))
      throw new IllegalArgumentException("ad_revenue_invalid");
    try {
      return new org.json.JSONObject().put("event_name", "ad_revenue")
          .put("subject_scope", "installation_level").put("installation_id", installationId)
          .put("impression_id", impressionId).put("amount_unscaled", amountUnscaled)
          .put("amount_scale", 6).put("currency", "USD").put("currency_source", "reported")
          .put("revenue_source", "client_estimated").put("revenue_precision", precision)
          .put("ad_network", network).put("ad_unit_id", adUnitId).put("mediation_provider", mediationProvider)
          .put("extensions", new org.json.JSONObject().put("ad_format", format));
    } catch (org.json.JSONException error) { throw new IllegalArgumentException("ad_revenue_invalid"); }
  }

  public static boolean trackMaxRevenue(double revenue, String precision, String networkName,
      String adUnitId, String placement, String networkPlacement) {
    return trackMaxRevenue(revenue, precision, networkName, adUnitId, "unknown", placement, networkPlacement);
  }

  public static boolean trackMaxRevenue(double revenue, String precision, String networkName,
      String adUnitId, String format, String placement, String networkPlacement) {
    return OpenMasuMaxBridge.track(
        requireSdk(), revenue, precision, networkName, adUnitId, format, placement, networkPlacement);
  }

  static PlayReferrerReader createPlayReferrerReader(Context context, boolean enabled) {
    if (!enabled) return unavailablePlayReader();
    try {
      Class<?> type = Class.forName("dev.openmasu.sdk.installreferrer.GooglePlayReferrerReader");
      Constructor<?> constructor = type.getConstructor(Context.class, long.class);
      return (PlayReferrerReader) constructor.newInstance(context.getApplicationContext(), 5L);
    } catch (ReflectiveOperationException | LinkageError exception) {
      return unavailablePlayReader();
    }
  }

  static MetaReferrerReader createMetaReferrerReader(ContentResolver resolver, String metaAppId) {
    String normalizedAppId = normalizeMetaAppId(metaAppId);
    if (normalizedAppId == null) return unavailableMetaReader();
    try {
      Class<?> type = Class.forName("dev.openmasu.sdk.metareferrer.MetaInstallReferrerReader");
      Constructor<?> constructor = type.getConstructor(ContentResolver.class, String.class);
      return (MetaReferrerReader) constructor.newInstance(resolver, normalizedAppId);
    } catch (ReflectiveOperationException | LinkageError exception) {
      return unavailableMetaReader();
    }
  }

  private static String normalizeMetaAppId(String value) {
    if (value == null) return null;
    String normalized = value.trim();
    return normalized.matches("^[A-Za-z0-9._~-]{1,64}$") ? normalized : null;
  }

  private static PlayReferrerReader unavailablePlayReader() {
    return () -> new PlayReferrerEvidence(
        "unavailable", "service_unavailable", null, null, null, null, null, null, null,
        null, Collections.emptyMap(), null, false);
  }

  private static MetaReferrerReader unavailableMetaReader() {
    return () -> new MetaReferrerEvidence("provider_unavailable", null, null, null, null);
  }

  private static OpenMasuSdk requireSdk() {
    OpenMasuSdk value = sdk;
    if (value == null) throw new IllegalStateException("OpenMasu is not initialized");
    return value;
  }
}
