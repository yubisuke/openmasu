import { receiveApplePostback } from "../apple-postback-receiver.js";
import { receiveMax } from "../max-receiver.js";
import { handleApplePurchasePreparation, handleDeviceDsar, handleDevicePrivacy, handleSdkBatch, handleSdkEnrollment } from "../sdk-routes.js";
import { receiveGooglePlayRtdn } from "../google-play-rtdn-receiver.js";
import { handleServerBatch } from "../server-routes.js";
import { receiveAppleStoreNotification } from "../apple-store-notifications-receiver.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { HttpRequestContext } from "./context.js";
import { json } from "../http-responses.js";

export function createReceiversControllers(dependencies: Pick<RequestHandlerDependencies, "maxConfig" | "maxBucket" | "pool" | "payloadStore" | "applePostback" | "googlePlayRtdn" | "appleStoreNotifications" | "sdk" | "server">) {
  const health = async ({ response }: HttpRequestContext): Promise<void> => {
    json(response, 200, { status: "ok" });
    return;
  };

  const maxIngest = async ({ request, response, pool }: HttpRequestContext): Promise<void> => {
    if (!request.url?.startsWith(`/v1/ingest/max/${dependencies.maxConfig.pathSecret}?`)) {
      json(response, 404, { error: "not_found" });
      return;
    }
    if (dependencies.maxBucket && !dependencies.maxBucket.allow()) {
      response.writeHead(429, { "retry-after": "1" }).end();
      return;
    }
    await receiveMax(request, response, {
      pool: dependencies.pool,
      payloadStore: dependencies.payloadStore,
      config: dependencies.maxConfig,
    });
    return;
  };

  const appleSkanPostback = async ({ request, response, route }: HttpRequestContext): Promise<void> => {
    if (!dependencies.applePostback) {
      json(response, 503, { error: "apple_postback_receiver_unavailable" });
      return;
    }
    await receiveApplePostback(
      request,
      response,
      route.handler === "apple_skan_postback" ? "skadnetwork" : "adattributionkit",
      dependencies.applePostback,
    );
    return;
  };

  const googlePlayRtdn = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (!dependencies.googlePlayRtdn) {
      json(response, 503, { error: "google_play_rtdn_receiver_unavailable" });
      return;
    }
    await receiveGooglePlayRtdn(request, response, dependencies.googlePlayRtdn);
    return;
  };

  const appleStoreNotification = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (!dependencies.appleStoreNotifications) {
      json(response, 503, { error: "apple_store_notification_receiver_unavailable" });
      return;
    }
    await receiveAppleStoreNotification(request, response, dependencies.appleStoreNotifications);
    return;
  };

  const sdkEnrollment = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (dependencies.sdk) return handleSdkEnrollment(request, response, dependencies.sdk);
    json(response, 404, { error: "not_found" });
  };

  const sdkBatch = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (dependencies.sdk) return handleSdkBatch(request, response, dependencies.sdk);
    json(response, 404, { error: "not_found" });
  };

  const applePurchasePrepare = async ({ request, response, route }: HttpRequestContext): Promise<void> => {
    if (!dependencies.sdk) return json(response, 503, { error: "app_store_purchase_preparation_unavailable" });
    return handleApplePurchasePreparation(request, response, dependencies.sdk, route.handler === "apple_purchase_submit");
  };

  const serverBatch = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (!dependencies.server) {
      json(response, 503, { error: "server_ingest_unavailable" });
      return;
    }
    return handleServerBatch(request, response, dependencies.server);
  };

  const devicePrivacy = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (dependencies.sdk) return handleDevicePrivacy(request, response, dependencies.sdk);
    json(response, 404, { error: "not_found" });
  };

  const deviceDsar = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (dependencies.sdk) return handleDeviceDsar(request, response, dependencies.sdk);
    json(response, 404, { error: "not_found" });
  };

  return {
    health: { boundary: "receiver", handle: health },
    max_ingest: { boundary: "receiver", handle: maxIngest },
    apple_skan_postback: { boundary: "receiver", handle: appleSkanPostback },
    apple_aak_postback: { boundary: "receiver", handle: appleSkanPostback },
    google_play_rtdn: { boundary: "receiver", handle: googlePlayRtdn },
    apple_store_notification: { boundary: "receiver", handle: appleStoreNotification },
    sdk_enrollment: { boundary: "receiver", handle: sdkEnrollment },
    sdk_batch: { boundary: "receiver", handle: sdkBatch },
    apple_purchase_prepare: { boundary: "receiver", handle: applePurchasePrepare },
    apple_purchase_submit: { boundary: "receiver", handle: applePurchasePrepare },
    server_batch: { boundary: "receiver", handle: serverBatch },
    device_privacy: { boundary: "receiver", handle: devicePrivacy },
    device_dsar: { boundary: "receiver", handle: deviceDsar },
  } as const;
}
