import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { appleAssociationDocument, assetLinksDocument, associationBytes, type AppLinkIdentity } from "@openmasu/app-association";
import {
  bindDeepLinkParameters,
  assertDeepLinkValue,
  classifyClientClass,
  fallbackResponse,
  prefetchEvidence,
  resolveRedirect,
  type RedirectResolution,
  type TrackingLink,
} from "@openmasu/redirector-core";
import { appendDurableBatch, uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";

export type RedirectRateLimiter = {
  allow(key: string): boolean;
  classify?(key: string): "normal" | "elevated" | "saturated";
};

export type RedirectorDependencies = {
  pool: Pool;
  payloadStore: PayloadStore;
  tenantId: string;
  fallbackUrl: string;
  geoMode: "off" | "country";
  limiter: RedirectRateLimiter;
  wellKnownLimiter?: RedirectRateLimiter;
  hostMode?: "host_header" | "fixed_tenant";
  referrerMaximumEncodedCharacters?: number;
  wellKnownCacheSeconds?: number;
  wellKnownMaximumBytes?: number;
  clientClassEnabled?: boolean;
  remoteClickParameter?: string;
  clock?: () => Date;
};

async function loadLink(pool: Pool, tenantId: string, slug: string): Promise<TrackingLink | undefined> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<TrackingLink>(
      `SELECT tracking_link_id, tenant_id, app_id, slug, destination_kind,
              destination_url, play_package_name, network, site_id,
              campaign_id, ad_group_id, creative_id, deep_link_value,
              deep_link_param_names, deferred_deep_link_ttl_seconds, status
       FROM control.tracking_links_current
       WHERE tenant_id=$1 AND slug=$2`,
      [tenantId, slug],
    );
    return result.rows[0];
  });
}

async function loadAssociation(
  pool: Pool,
  tenantId: string,
  host: string,
): Promise<{ readonly assetlinks: Buffer; readonly aasa: Buffer } | undefined> {
  return withTenant(pool, tenantId, async (client) => {
    const domain = await client.query("SELECT 1 FROM control.link_domains WHERE tenant_id=$1 AND host=$2", [tenantId, host]);
    if (domain.rowCount !== 1) return undefined;
    const identities = await client.query<AppLinkIdentity>(
      `SELECT app_id, android_package_name, android_sha256_fingerprints,
              apple_team_id, apple_bundle_id
         FROM control.app_link_identities
        WHERE tenant_id=$1 ORDER BY app_id`,
      [tenantId],
    );
    return {
      assetlinks: associationBytes(assetLinksDocument(identities.rows)),
      aasa: associationBytes(appleAssociationDocument(identities.rows)),
    };
  });
}

async function tenantForRequest(
  dependencies: RedirectorDependencies,
  host: string | undefined,
): Promise<string | undefined> {
  if ((dependencies.hostMode ?? "fixed_tenant") === "fixed_tenant") return dependencies.tenantId;
  if (!host) return undefined;
  const result = await dependencies.pool.query<{ tenant_id: string }>(
    "SELECT control.resolve_link_host($1) AS tenant_id",
    [host],
  );
  return result.rows[0]?.tenant_id ?? undefined;
}

function normalizedHost(request: IncomingMessage): string | undefined {
  const value = String(request.headers.host ?? "").split(":", 1)[0].toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]{3,253}$/.test(value) ? value : undefined;
}

function sendAssociation(response: ServerResponse, body: Buffer, cacheSeconds: number): void {
  response.writeHead(200, {
    "cache-control": `public, max-age=${cacheSeconds}`,
    "content-type": "application/json",
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function send(response: ServerResponse, result: RedirectResolution): void {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

async function persistClick(dependencies: RedirectorDependencies, result: RedirectResolution): Promise<void> {
  const click = result.click ?? result.prefetch;
  if (!click) return;
  const record = {
    contract_version: "0.4.0",
    record_id: `record:${uuidV7()}`,
    delivery_id: `delivery:${uuidV7()}`,
    tenant_id: click.tenant_id,
    app_id: click.app_id,
    producer: "redirector",
    producer_version: "0.1.0",
    event_id: result.click ? `event:click:${result.click.click_id}` : `event:prefetch:${uuidV7()}`,
    event_name: "click",
    schema_version: "0.4.0",
    occurred_at: click.redirector_click_at,
    occurred_at_source: "server",
    received_at: click.redirector_click_at,
    processing_purpose_id: "analytics",
    processing_sequence: 1,
    payload: {
      ...(result.click ? { click_id: result.click.click_id } : {}),
      tracking_link_id: click.tracking_link_id,
      redirector_click_at: click.redirector_click_at,
      redirector_time_status: "available",
      ...(click.campaign_id ? { campaign_id: click.campaign_id } : {}),
      ...(click.ad_group_id ? { ad_group_id: click.ad_group_id } : {}),
      ...(click.creative_id ? { creative_id: click.creative_id } : {}),
      ...(click.network ? { network: click.network } : {}),
      ...(click.site_id ? { site_id: click.site_id } : {}),
      ...(click.remote_click_ref ? { remote_click_ref: click.remote_click_ref } : {}),
      ...(click.source_rate_class ? { source_rate_class: click.source_rate_class } : {}),
      ...(click.client_class ? { client_class: click.client_class } : {}),
      ...(click.deep_link_value ? { deep_link_value: click.deep_link_value } : {}),
      ...(click.deferred_deep_link_status ? { deferred_deep_link_status: click.deferred_deep_link_status } : {}),
      ...(result.prefetch || result.click?.bot_prefetch ? { bot_prefetch: true } : {}),
    },
  };
  await appendDurableBatch(dependencies.pool, dependencies.payloadStore, {
    tenantId: click.tenant_id,
    appId: click.app_id,
    producer: "redirector",
    body: Buffer.from(JSON.stringify({ records: [record] }), "utf8"),
    eventCount: 1,
    receivedAt: click.redirector_click_at,
  });
}

export function createRedirectorHandler(dependencies: RedirectorDependencies): RequestListener {
  const fallback = fallbackResponse(dependencies.fallbackUrl);
  return (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const target = new URL(request.url ?? "/", "http://openmasu.local");
      const wellKnown = request.method === "GET" && (target.pathname === "/.well-known/assetlinks.json"
        || target.pathname === "/.well-known/apple-app-site-association");
      const host = normalizedHost(request);
      let tenantId: string | undefined;
      try { tenantId = await tenantForRequest(dependencies, host); }
      catch { response.writeHead(404).end(); return; }
      if (wellKnown) {
        if (!(dependencies.wellKnownLimiter ?? { allow: () => true }).allow("well-known")) {
          response.writeHead(429, { "cache-control": "no-store", "retry-after": "1" });
          response.end();
          return;
        }
        if (!host || !tenantId) { response.writeHead(404).end(); return; }
        let documents: Awaited<ReturnType<typeof loadAssociation>>;
        try { documents = await loadAssociation(dependencies.pool, tenantId, host); }
        catch { response.writeHead(404).end(); return; }
        if (!documents) { response.writeHead(404).end(); return; }
        const body = target.pathname.endsWith("assetlinks.json") ? documents.assetlinks : documents.aasa;
        if (body.length > (dependencies.wellKnownMaximumBytes ?? 65_536)) {
          response.writeHead(503, { "cache-control": "no-store", "x-content-type-options": "nosniff" });
          response.end();
          return;
        }
        sendAssociation(response, body, dependencies.wellKnownCacheSeconds ?? 300);
        return;
      }
      const match = request.method === "GET" ? /^\/r\/([A-Za-z0-9_-]{12,64})(\/.*)?$/.exec(target.pathname) : null;
      if (!match) return send(response, fallback);
      if (!tenantId) return send(response, fallback);
      const remoteAddress = request.socket.remoteAddress ?? "unknown";
      if (!dependencies.limiter.allow(remoteAddress)) {
        response.writeHead(429, { "cache-control": "no-store", "retry-after": "1" });
        response.end();
        return;
      }
      let link: TrackingLink | undefined;
      try { link = await loadLink(dependencies.pool, tenantId, match[1]); }
      catch { return send(response, fallback); }
      if (!link || link.status !== "active") return send(response, fallback);
      let directDeepLinkValue: string | undefined;
      if (match[2]) {
        try { directDeepLinkValue = assertDeepLinkValue(match[2]); }
        catch { return send(response, fallback); }
      }
      const remoteClickRef = target.searchParams.get(dependencies.remoteClickParameter ?? "cid") ?? undefined;
      if (remoteClickRef && !/^[A-Za-z0-9._~-]{1,128}$/.test(remoteClickRef)) return send(response, fallback);
      const sourceRateClass = dependencies.limiter.classify?.(remoteAddress) ?? "normal";
      const clientClass = dependencies.clientClassEnabled === false
        ? undefined
        : classifyClientClass(String(request.headers["user-agent"] ?? ""));
      const purpose = `${request.headers.purpose ?? ""} ${request.headers["sec-purpose"] ?? ""}`;
      if (/prefetch/i.test(purpose)) {
        const result = prefetchEvidence({
          link,
          fallbackDestination: dependencies.fallbackUrl,
          now: (dependencies.clock ?? (() => new Date()))().toISOString(),
          ...(remoteClickRef ? { remoteClickRef } : {}),
          sourceRateClass,
          ...(clientClass ? { clientClass } : {}),
        });
        await persistClick(dependencies, result);
        return send(response, result);
      }
      if (link.destination_kind === "play_store" && !/Android/i.test(request.headers["user-agent"] ?? "")) {
        return send(response, fallback);
      }
      try {
        const result = resolveRedirect({
          link,
          fallbackDestination: dependencies.fallbackUrl,
          now: (dependencies.clock ?? (() => new Date()))().toISOString(),
          ...(remoteClickRef ? { remoteClickRef } : {}),
          sourceRateClass,
          ...(clientClass ? { clientClass } : {}),
          deepLinkParams: bindDeepLinkParameters(target.searchParams, link.deep_link_param_names ?? []).values,
          referrerMaximumEncodedCharacters: dependencies.referrerMaximumEncodedCharacters ?? 512,
          ...(directDeepLinkValue ? { deepLinkValue: directDeepLinkValue } : {}),
        });
        await persistClick(dependencies, result);
        send(response, result);
      } catch {
        send(response, fallback);
      }
    })();
  };
}
