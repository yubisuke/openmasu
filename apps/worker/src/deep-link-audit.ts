import { sha256 } from "@openmasu/attribution-core";

export type DeepLinkAuditEvidence = {
  readonly evidence_class: "device_reported_unverified";
  readonly open_source: "android_app_link" | "ios_universal_link" | "custom_scheme" | "android_deferred_referrer";
  readonly resolution_status: "active" | "inactive" | "unknown";
  readonly observed_redirect_click: boolean;
  readonly install_click_reused: boolean;
  readonly installation_attribution_mutated: false;
};

export function buildDeepLinkAuditEvidence(input: {
  readonly openSource: DeepLinkAuditEvidence["open_source"];
  readonly resolutionStatus: DeepLinkAuditEvidence["resolution_status"];
  readonly claimedClickId?: string;
  readonly installAttributionClickId?: string;
}): { readonly evidence: DeepLinkAuditEvidence; readonly reasonCode: string; readonly digest: string } {
  const deferred = input.openSource === "android_deferred_referrer";
  const installClickReused = deferred
    && input.installAttributionClickId !== undefined
    && input.installAttributionClickId === input.claimedClickId;
  const evidence: DeepLinkAuditEvidence = {
    evidence_class: "device_reported_unverified",
    open_source: input.openSource,
    resolution_status: input.resolutionStatus,
    observed_redirect_click: deferred && input.resolutionStatus !== "unknown",
    install_click_reused: installClickReused,
    installation_attribution_mutated: false,
  };
  const reasonCode = installClickReused
    ? "deep_link_install_click_reused"
    : input.resolutionStatus === "active"
      ? "device_claim_observed"
      : input.resolutionStatus === "inactive"
        ? "deep_link_link_inactive"
        : "deep_link_unknown_link";
  return { evidence, reasonCode, digest: sha256(evidence) };
}
