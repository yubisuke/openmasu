import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import { assertDeepLinkValue, bindDeepLinkParameters, redirectFallbackReason, resolveRedirect,
  type TrackingLink, type RedirectPlatform } from "@openmasu/redirector-core";

// Same length as the 33-byte live click ID; never random or persisted.
export const PREVIEW_CLICK_PLACEHOLDER = "synthetic_preview_".padEnd(44, "_");
export type TrackingLinkPreview = {
  preview_only: true; tracking_link_id: string; platform: RedirectPlatform;
  link_status: TrackingLink["status"]; destination: string; fallback_reason: string | null;
  requested_path: string | null; permitted_parameters: readonly string[];
  bound_parameters: Readonly<Record<string, string>>; dropped_parameter_count: number;
  referrer: string | null; referrer_characters: number | null; referrer_budget: number;
  deferred_status: "carried" | "omitted_length" | "omitted_platform" | "not_configured" | "not_applicable";
  click_id_placeholder: string;
};

/** Calculates stored routing only. Does not persist a click, resolve DNS or fetch a destination. */
export function buildTrackingLinkPreview(link: TrackingLink, parameters: URLSearchParams,
  configuration: { fallbackUrl: string; referrerMaximumEncodedCharacters?: number }): TrackingLinkPreview {
  const names = link.deep_link_param_names ?? [];
  if (parameters.toString().length > 4096 || [...parameters.keys()].some(key => parameters.getAll(key).length !== 1
    || !["platform", "path"].includes(key) && !names.some(name => key === `dlp_${name}`))) throw new Error("tracking_preview_input_invalid");
  const platform = parameters.get("platform");
  if (!["android", "ios", "other"].includes(platform ?? "")) throw new Error("tracking_preview_platform_required");
  const source = new URLSearchParams([...parameters].filter(([key]) => key.startsWith("dlp_")));
  const bound = bindDeepLinkParameters(source, names), path = parameters.get("path") || undefined;
  let reason: string | null = redirectFallbackReason(link, platform as RedirectPlatform) ?? null;
  if (!reason && path) { try { assertDeepLinkValue(path); } catch { reason = "invalid_deep_link_path"; } }
  const maximum = configuration.referrerMaximumEncodedCharacters ?? 512;
  let resolution: ReturnType<typeof resolveRedirect> | undefined;
  if (!reason) {
    try {
      resolution = resolveRedirect({ link, fallbackDestination: configuration.fallbackUrl, platform: platform as RedirectPlatform,
        now: "1970-01-01T00:00:00.000Z", clickId: PREVIEW_CLICK_PLACEHOLDER,
        deepLinkParams: bound.values, ...(path ? { deepLinkValue: path } : {}), referrerMaximumEncodedCharacters: maximum });
    } catch { reason = "routing_configuration_invalid"; }
  }
  const carriesReferrer = !reason && link.destination_kind === "play_store";
  return { preview_only: true, tracking_link_id: link.tracking_link_id, platform: platform as RedirectPlatform,
    link_status: link.status, destination: resolution?.headers.location ?? configuration.fallbackUrl, fallback_reason: reason,
    requested_path: path ?? null, permitted_parameters: [...names], bound_parameters: bound.values, dropped_parameter_count: bound.dropped,
    referrer: carriesReferrer ? resolution!.click!.referrer : null,
    referrer_characters: carriesReferrer ? resolution!.click!.referrer.length : null, referrer_budget: maximum,
    deferred_status: reason === "platform_not_supported" ? "omitted_platform" : carriesReferrer
      ? resolution!.click!.deferred_deep_link_status! as "carried" | "omitted_length" | "not_configured" : "not_applicable",
    click_id_placeholder: PREVIEW_CLICK_PLACEHOLDER };
}

export async function previewTrackingLink(pool: Pool, identity: { tenantId: string; appId: string }, id: string,
  parameters: URLSearchParams, configuration: Parameters<typeof buildTrackingLinkPreview>[2]): Promise<TrackingLinkPreview> {
  return withTenant(pool, identity.tenantId, async client => {
    const row = (await client.query<{ artifact: TrackingLink; status: TrackingLink["status"] }>(
      `SELECT link.artifact,state.status FROM control.tracking_links link
       JOIN LATERAL (SELECT candidate.status FROM control.tracking_link_states candidate
         WHERE candidate.tenant_id=link.tenant_id AND candidate.app_id=link.app_id AND candidate.tracking_link_id=link.tracking_link_id
         ORDER BY candidate.tracking_link_state_seq DESC LIMIT 1) state ON true
       WHERE link.tenant_id=$1 AND link.app_id=$2 AND link.tracking_link_id=$3`, [identity.tenantId, identity.appId, id])).rows[0];
    if (!row) throw new Error("tracking_link_not_found");
    return buildTrackingLinkPreview({ ...row.artifact, tenant_id: identity.tenantId, app_id: identity.appId, status: row.status }, parameters, configuration);
  });
}
