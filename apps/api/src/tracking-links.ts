import type { Pool } from "pg";
import { assertAllowedDestination, assertDeepLinkValue, buildDeferredReferrer, randomSlug } from "@openmasu/redirector-core";
import { uuidV7, withTenant } from "@openmasu/runtime";
import { recordDashboardAudit } from "./session.js";

type Any = Record<string, any>;

export type TrackingLinkRecord = {
  readonly tracking_link_id: string;
  readonly slug: string;
  readonly destination_kind: "play_store" | "custom_https";
  readonly destination_url: string;
  readonly play_package_name?: string;
  readonly network?: string;
  readonly site_id?: string;
  readonly campaign_id?: string;
  readonly ad_group_id?: string;
  readonly creative_id?: string;
  readonly deep_link_value?: string;
  readonly deep_link_param_names: readonly string[];
  readonly deferred_deep_link_ttl_seconds: number;
  readonly created_at: string;
  readonly status: "active" | "paused" | "archived";
};

export async function listTrackingLinks(
  pool: Pool,
  tenantId: string,
  appId: string,
): Promise<readonly TrackingLinkRecord[]> {
  const result = await withTenant(pool, tenantId, (client) => client.query<{
    tracking_link_id: string;
    slug: string;
    destination_kind: "play_store" | "custom_https";
    destination_url: string;
    play_package_name: string | null;
    network: string | null;
    site_id: string | null;
    campaign_id: string | null;
    ad_group_id: string | null;
    creative_id: string | null;
    deep_link_value: string | null;
    deep_link_param_names: string[];
    deferred_deep_link_ttl_seconds: number;
    created_at: string;
    status: "active" | "paused" | "archived";
  }>(
    `SELECT link.tracking_link_id, link.slug, link.destination_kind,
            link.destination_url, link.play_package_name, link.network,
            link.site_id, link.campaign_id, link.ad_group_id, link.creative_id,
            link.deep_link_value, link.deep_link_param_names, link.deferred_deep_link_ttl_seconds,
            link.created_at, state.status
       FROM control.tracking_links AS link
       JOIN LATERAL (
         SELECT candidate.status
           FROM control.tracking_link_states AS candidate
          WHERE candidate.tenant_id=link.tenant_id
            AND candidate.app_id=link.app_id
            AND candidate.tracking_link_id=link.tracking_link_id
          ORDER BY candidate.tracking_link_state_seq DESC
          LIMIT 1
       ) AS state ON true
      WHERE link.tenant_id=$1 AND link.app_id=$2
      ORDER BY link.created_at DESC, link.tracking_link_id COLLATE "C"
      LIMIT 200`,
    [tenantId, appId],
  ));
  return result.rows.map((row) => ({
    tracking_link_id: row.tracking_link_id,
    slug: row.slug,
    destination_kind: row.destination_kind,
    destination_url: row.destination_url,
    ...(row.play_package_name ? { play_package_name: row.play_package_name } : {}),
    ...(row.network ? { network: row.network } : {}),
    ...(row.site_id ? { site_id: row.site_id } : {}),
    ...(row.campaign_id ? { campaign_id: row.campaign_id } : {}),
    ...(row.ad_group_id ? { ad_group_id: row.ad_group_id } : {}),
    ...(row.creative_id ? { creative_id: row.creative_id } : {}),
    ...(row.deep_link_value ? { deep_link_value: row.deep_link_value } : {}),
    deep_link_param_names: row.deep_link_param_names,
    deferred_deep_link_ttl_seconds: row.deferred_deep_link_ttl_seconds,
    created_at: row.created_at,
    status: row.status,
  }));
}

export async function createTrackingLink(input: {
  pool: Pool;
  tenantId: string;
  appId: string;
  actorRef: string;
  allowedOrigins: readonly string[];
  body: Any;
  referrerMaximumEncodedCharacters?: number;
  now?: string;
}): Promise<Any> {
  const destinationKind = input.body.destination_kind;
  if (destinationKind !== "play_store" && destinationKind !== "custom_https") throw new Error("destination_kind_invalid");
  const destination = assertAllowedDestination(String(input.body.destination_url ?? ""), input.allowedOrigins);
  if (destinationKind === "play_store"
    && !(destination.protocol === "market:" || (destination.hostname === "play.google.com" && destination.pathname === "/store/apps/details"))) {
    throw new Error("play_destination_required");
  }
  if (destinationKind === "custom_https" && destination.protocol !== "https:") throw new Error("custom_https_required");
  const packageName = destinationKind === "play_store" ? String(input.body.play_package_name ?? "") : undefined;
  if (destinationKind === "play_store" && !/^[A-Za-z][A-Za-z0-9_.]{2,254}$/.test(packageName!)) {
    throw new Error("play_package_name_invalid");
  }
  const now = input.now ?? new Date().toISOString();
  const deepLinkValue = input.body.deep_link_value === undefined ? undefined : assertDeepLinkValue(String(input.body.deep_link_value));
  const deepLinkParamNames = Array.isArray(input.body.deep_link_param_names)
    ? input.body.deep_link_param_names.map(String)
    : [];
  if (deepLinkParamNames.length > 10 || new Set(deepLinkParamNames).size !== deepLinkParamNames.length
    || deepLinkParamNames.some((name: string) => !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
    throw new Error("deep_link_param_names_invalid");
  }
  const deferredTtl = Number(input.body.deferred_deep_link_ttl_seconds ?? 604800);
  if (!Number.isInteger(deferredTtl) || deferredTtl < 0 || deferredTtl > 7776000) throw new Error("deferred_deep_link_ttl_invalid");
  if (deepLinkValue) {
    const maximumParams = Object.fromEntries(deepLinkParamNames.map((name: string) => [name, "x".repeat(64)]));
    const probe = buildDeferredReferrer({
      clickId: "x".repeat(44), deepLinkValue, deepLinkParams: maximumParams,
      maximumEncodedCharacters: input.referrerMaximumEncodedCharacters ?? 512,
    });
    if (probe.status !== "carried") throw new Error("deep_link_referrer_budget_exceeded");
  }
  const artifact = {
    tracking_link_id: `tracking-link:${uuidV7()}`,
    tenant_id: input.tenantId,
    app_id: input.appId,
    slug: randomSlug(),
    destination_kind: destinationKind,
    destination_url: destination.toString(),
    ...(packageName ? { play_package_name: packageName } : {}),
    ...(input.body.network ? { network: String(input.body.network) } : {}),
    ...(input.body.site_id ? { site_id: String(input.body.site_id) } : {}),
    ...(input.body.campaign_id ? { campaign_id: String(input.body.campaign_id) } : {}),
    ...(input.body.ad_group_id ? { ad_group_id: String(input.body.ad_group_id) } : {}),
    ...(input.body.creative_id ? { creative_id: String(input.body.creative_id) } : {}),
    ...(deepLinkValue ? { deep_link_value: deepLinkValue } : {}),
    deep_link_param_names: deepLinkParamNames,
    deferred_deep_link_ttl_seconds: deferredTtl,
    created_at: now,
    status: "active",
  };
  await withTenant(input.pool, input.tenantId, async (client) => {
    await client.query(
      `INSERT INTO control.tracking_links (
        tracking_link_id, tenant_id, app_id, slug, destination_kind, destination_url,
        play_package_name, network, site_id, campaign_id, ad_group_id, creative_id,
        deep_link_value, deep_link_param_names, deferred_deep_link_ttl_seconds,
        created_at, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
      [artifact.tracking_link_id, input.tenantId, input.appId, artifact.slug,
        destinationKind, artifact.destination_url, packageName ?? null,
        artifact.network ?? null, artifact.site_id ?? null, artifact.campaign_id ?? null,
        artifact.ad_group_id ?? null, artifact.creative_id ?? null,
        deepLinkValue ?? null, deepLinkParamNames, deferredTtl, now, JSON.stringify(artifact)],
    );
    await client.query(
      `INSERT INTO control.tracking_link_states (
        tracking_link_id, tenant_id, app_id, status, changed_at, artifact
      ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
      [artifact.tracking_link_id, input.tenantId, input.appId, now,
        JSON.stringify({ tracking_link_id: artifact.tracking_link_id, status: "active", changed_at: now })],
    );
  });
  await recordDashboardAudit(input.pool, {
    tenantId: input.tenantId,
    appId: input.appId,
    actorRef: input.actorRef,
    action: "tracking_link_created",
    targetScope: "tracking_link",
    targetRef: artifact.tracking_link_id,
    outcome: "succeeded",
    now: new Date(now),
  });
  return artifact;
}
