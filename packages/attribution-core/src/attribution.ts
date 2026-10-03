import { decisionFor, evidenceKey, type CandidateProvider } from "./candidates.js";
import { boundNonFraudBundle } from "./rule-bundles.js";
import { CONTRACT_VERSION, type Attribution, type Attempt, type Decisions, type EvidenceRef, type LifecycleStatus } from "./evaluation-model.js";
import { DAY_MS, sortByKey, time } from "./evaluation-utils.js";

function makeAttribution(
  attempt: Attempt,
  candidates: CandidateProvider,
  decisions: Decisions,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record: install } = attempt;
  const payload = install.payload;
  const attributionBundle = boundNonFraudBundle(server, "attribution-default");
  const evidence = (ref: string): EvidenceRef => ({
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ref,
    lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, ref)) ?? "available",
    access_class: "protected",
  });
  const base = {
    attribution_id: `attr:${install.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "installation_level" as const,
    subject_ref: payload.installation_id,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [evidence(install.record_id)],
    effective_at: install.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final" as const,
    ...attributionBundle,
  } satisfies Omit<Attribution, "status" | "method" | "model" | "reason_code">;
  const result = (
    status: Attribution["status"],
    method: Attribution["method"],
    model: Attribution["model"],
    reason_code: Attribution["reason_code"],
    extra: Partial<Attribution> = {},
  ): Attribution => {
    const attribution: Attribution = { ...base, status, method, model, reason_code, ...extra };
    if (!attribution.evidence_refs.some((entry) => entry.lifecycle_status !== "available")) return attribution;
    return {
      ...attribution,
      attribution_id: `${base.attribution_id}:recalculated`,
      finality: "superseded",
      supersedes_attribution_id: base.attribution_id,
    };
  };
  const importedProducer = install.producer.startsWith("import:");
  const imported = importedProducer ? payload.import_context : undefined;
  if (importedProducer) {
    if (!imported) return result("unattributed", "imported", "provider_reported", "provider_unattributed");
    const referencedClicks = imported.provider_click_ref
      ? candidates.all().filter((candidate) =>
        candidate.server.tenant_id === server.tenant_id && candidate.server.app_id === server.app_id &&
        candidate.record.event_name === "click" && candidate.record.producer === "redirector" &&
        candidate.record.payload.remote_click_ref === imported.provider_click_ref &&
        decisionFor(decisions, candidate).ingestion_status === "accepted" &&
        decisionFor(decisions, candidate).duplicate_resolution === "unique",
      )
      : [];
    const importedEvidence = referencedClicks.length === 1
      ? { evidence_refs: [evidence(referencedClicks[0].record.record_id), evidence(install.record_id)] }
      : {};
    if (imported.provider_attributed) {
      if (imported.provider_attribution_strategy === "modeled") {
        return result("non_organic", "imported", "provider_reported", "provider_modeled_conversion", importedEvidence);
      }
      if (!imported.provider_confirmed_at) {
        return result("non_organic", "imported", "provider_reported", "provider_time_authority_unavailable", importedEvidence);
      }
      return result("non_organic", "imported", "provider_reported", "provider_attributed", importedEvidence);
    }
    if (imported.provider_attribution_strategy === "organic") {
      return result("organic", "imported", "provider_reported", "provider_organic");
    }
    return result("unattributed", "imported", "provider_reported", "provider_unattributed");
  }
  if (payload.meta_referrer_status === "decrypted") {
    return result(
      "non_organic",
      "meta_install_referrer",
      payload.meta_referrer_context.attribution_model,
      "meta_referrer_decrypted",
    );
  }
  if (["decrypt_failed", "auth_failed"].includes(payload.meta_referrer_status)) {
    return result(
      "unattributed",
      "meta_install_referrer",
      payload.meta_referrer_context?.attribution_model ?? "last_click",
      "meta_referrer_decrypt_failed",
    );
  }
  if (payload.adservices_context?.status === "attributed") {
    return result("non_organic", "apple_adservices", "last_click", "adservices_attributed");
  }
  if (payload.adservices_context?.status === "token_expired") {
    return result("unattributed", "apple_adservices", "last_click", "adservices_token_expired");
  }
  if (payload.adservices_context?.status === "not_attributed") {
    return result("unattributed", "apple_adservices", "last_click", "adservices_not_attributed");
  }
  if (payload.adservices_context?.status === "lookup_unavailable") {
    return result("unattributed", "apple_adservices", "last_click", "adservices_lookup_unavailable");
  }
  if (payload.referrer_status === "none") return result("organic", "none", "none", "no_referrer");
  if (payload.referrer_status === "third_party") {
    return payload.third_party_referrer_classification === "play_organic_marker"
      ? result("organic", "none", "none", "no_first_party_referrer")
      : result("unattributed", "none", "none", "foreign_referrer_unresolved");
  }
  if (payload.referrer_status === "unsupported") return result("unattributed", "none", "none", "install_referrer_unsupported");
  if (payload.referrer_status === "unavailable") return result("unattributed", "none", "none", "install_referrer_unavailable");
  if (payload.referrer_status === "not_applicable") return result("unattributed", "none", "none", "platform_referrer_not_available");
  const clicks = candidates.clickCandidates(server.tenant_id, server.app_id, payload.click_id).filter((candidate) =>
    decisionFor(decisions, candidate).ingestion_status === "accepted" &&
    decisionFor(decisions, candidate).duplicate_resolution === "unique",
  );
  if (!clicks.length) return result("unattributed", "none", "none", "unknown_click_id");
  if (clicks.length > 1) return result("unattributed", "none", "none", "ambiguous_click_id");
  const [click] = clicks;
  if (click.record.payload.bot_prefetch) {
    return result("unattributed", "none", "none", "bot_prefetch", {
      evidence_refs: [evidence(click.record.record_id), evidence(install.record_id)],
    });
  }
  const clickStatus = click.record.payload.redirector_time_status ?? "available";
  const installStatus = payload.install_begin_at_server_status ?? (payload.install_begin_at_server ? "available" : "missing");
  if (clickStatus === "invalid" || installStatus === "invalid") return result("unattributed", "none", "none", "authoritative_time_invalid");
  if (clickStatus !== "available" || installStatus !== "available" || !click.record.payload.redirector_click_at || !payload.install_begin_at_server) {
    return result("unattributed", "none", "none", "authoritative_time_missing");
  }
  const delta = time(payload.install_begin_at_server, "install_begin_at_server") -
    time(click.record.payload.redirector_click_at, "redirector_click_at");
  if (delta < 0 || delta >= 7 * DAY_MS) return result("unattributed", "none", "none", "window_expired");
  return result("non_organic", "install_referrer", "last_click", "valid_install_referrer", {
    evidence_refs: [evidence(click.record.record_id), evidence(install.record_id)],
  });
}

function makeAggregatePostbackAttribution(
  attempt: Attempt,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record } = attempt;
  const payload = record.payload;
  const postbackBundle = boundNonFraudBundle(server, "apple-postback-default");
  const isSkan = record.event_name === "skan_postback";
  const method: Attribution["method"] = isSkan ? "skadnetwork" : "adattributionkit";
  const evidence: EvidenceRef = {
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ref: record.record_id,
    lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, record.record_id)) ?? "available",
    access_class: "protected",
  };
  let status: Attribution["status"] = "non_organic";
  let reason_code: Attribution["reason_code"] = "skan_postback_verified";
  if (!payload.signature_verified) {
    status = "unattributed";
    reason_code = "skan_signature_invalid";
  } else if (!payload.did_win) {
    status = "unattributed";
    reason_code = "postback_not_winner";
  } else if (payload.source_identifier === undefined) {
    status = "unattributed";
    reason_code = "crowd_anonymity_suppressed";
  } else if (payload.conversion_value === undefined && payload.coarse_conversion_value === undefined) {
    status = "unattributed";
    reason_code = "conversion_value_null";
  }
  return {
    attribution_id: `attr:${record.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "aggregate",
    subject_ref: `aggregate:${method}:${record.record_id}`,
    status,
    method,
    model: "aggregate",
    reason_code,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [evidence],
    effective_at: record.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final",
    ...postbackBundle,
  };
}

function makeDeepLinkAttribution(
  attempt: Attempt,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record } = attempt;
  const resolution = server.deep_link_resolution ?? { status: "unknown" };
  const attributionBundle = boundNonFraudBundle(server, "attribution-default");
  const reusedInstallClick = record.payload.open_source === "android_deferred_referrer"
    && resolution.install_attribution_click_id === record.payload.click_id;
  const status: Attribution["status"] = resolution.status === "active" && !reusedInstallClick
    ? "non_organic" : "unattributed";
  const reason_code: Attribution["reason_code"] = reusedInstallClick
    ? "deep_link_install_click_reused"
    : resolution.status === "active" ? "deep_link_open_attributed"
      : resolution.status === "inactive" ? "deep_link_link_inactive"
        : "deep_link_unknown_link";
  return {
    attribution_id: `attr:engagement:${record.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "engagement_level",
    subject_ref: `engagement:${record.record_id}`,
    status,
    method: "deep_link",
    model: "last_click",
    reason_code,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [{
      tenant_id: server.tenant_id,
      app_id: server.app_id,
      ref: record.record_id,
      lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, record.record_id)) ?? "available",
      access_class: "protected",
    }],
    effective_at: record.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final",
    ...attributionBundle,
  };
}

export function initialAttributionArtifacts(
  acceptedUnique: Attempt[],
  acceptedCandidates: readonly Attempt[],
  candidates: CandidateProvider,
  decisions: Decisions,
  lifecycle: Map<string, LifecycleStatus>,
): { attributionInstallAttempts: Attempt[]; initialAttributions: Attribution[] } {
  const currentClickIds = new Set(acceptedUnique
    .filter((attempt) => attempt.record.event_name === "click")
    .map((attempt) => attempt.record.payload.click_id)
    .filter((clickId): clickId is string => typeof clickId === "string" && clickId.length > 0));
  const impactedHistoricalInstalls = acceptedCandidates.filter((attempt) =>
    attempt.history_state !== undefined
    && attempt.record.event_name === "install"
    && typeof attempt.record.payload.click_id === "string"
    && currentClickIds.has(attempt.record.payload.click_id));
  const attributionInstallAttempts = [
    ...acceptedUnique.filter((attempt) => attempt.record.event_name === "install"),
    ...impactedHistoricalInstalls,
  ];
  const initialAttributions = sortByKey([
    ...attributionInstallAttempts
      .map((attempt) => makeAttribution(attempt, candidates, decisions, lifecycle)),
    ...acceptedUnique
      .filter((attempt) => ["skan_postback", "adattributionkit_postback"].includes(attempt.record.event_name))
      .map((attempt) => makeAggregatePostbackAttribution(attempt, lifecycle)),
    ...acceptedUnique
      .filter((attempt) => attempt.record.event_name === "deep_link_open")
      .map((attempt) => makeDeepLinkAttribution(attempt, lifecycle)),
  ],
  (attribution) => [attribution.attribution_id, attribution.tenant_id, attribution.app_id]);
  return { attributionInstallAttempts, initialAttributions };
}
