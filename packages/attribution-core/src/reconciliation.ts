import { sha256 } from "./canonical.js";
import { compareText, compositeKey, sortByKey } from "./evaluation-utils.js";
import { CONTRACT_VERSION, type Any, type Attempt, type Reconciliation } from "./evaluation-model.js";

function importedReconciliationInputs(accepted: Attempt[]): Any[] {
  return accepted
    .filter((attempt) => attempt.record.event_name === "install" && attempt.record.producer.startsWith("import:"))
    .map((attempt) => {
      const context = attempt.record.payload.import_context ?? {};
      const providerKey = (type: "provider_install_id" | "provider_click_id", value: string): Any => ({
        type,
        value: sha256({ provider: context.provider, type, value }),
        scope: "tenant_app",
        normalization: "identity",
        cardinality: "one_to_one",
        protected: true,
        value_encoding: "sha256",
        access_class: "protected",
      });
      const matching_keys: Any[] = [];
      if (context.provider_install_ref) {
        matching_keys.push(providerKey("provider_install_id", context.provider_install_ref));
      }
      if (context.provider_click_ref) {
        matching_keys.push(providerKey("provider_click_id", context.provider_click_ref));
      }
      return {
        reconciliation_id: `reconciliation:import:${attempt.record.record_id}`,
        tenant_id: attempt.server.tenant_id,
        app_id: attempt.server.app_id,
        input_snapshot_id: `snapshot:internal:${attempt.record.record_id}`,
        external_snapshot_id: `snapshot:provider:${attempt.record.record_id}`,
        matching_keys,
        provider_modeled_without_candidate:
          context.provider_attribution_strategy === "modeled" && matching_keys.length === 0,
        candidates: matching_keys.length ? [{
          candidate_id: attempt.record.record_id,
          tenant_id: attempt.server.tenant_id,
          app_id: attempt.server.app_id,
          matching_keys,
          window_status: "not_applicable",
          freshness: "current",
          excluded: false,
        }] : [],
        freshness: "current",
      };
    });
}

export function reconciliationResults(input: Any, accepted: Attempt[]): Reconciliation[] {
  const reconciliationInputs = [...(input.reconciliation_inputs ?? []), ...importedReconciliationInputs(accepted)];
  const identities = reconciliationInputs.map((item: Any) => compositeKey([item.tenant_id, item.app_id, item.reconciliation_id]));
  if (new Set(identities).size !== identities.length) throw new Error("duplicate reconciliation identity");
  const output: Reconciliation[] = reconciliationInputs.map((item: Any): Reconciliation => {
    const normalized = (entry: Any): string => {
      if (entry.normalization === "lowercase_ascii") return entry.value.replace(/[A-Z]/g, (character: string) => character.toLowerCase());
      if (entry.normalization === "trim") return entry.value.trim();
      return entry.value;
    };
    const key = (entry: Any) => `${entry.type}:${entry.value_encoding ? `${entry.value_encoding}:` : ""}${normalized(entry)}`;
    const externalKeys = new Set((item.matching_keys ?? []).map(key));
    const matched = (item.candidates ?? []).filter((candidate: Any) =>
      candidate.tenant_id === item.tenant_id && candidate.app_id === item.app_id &&
      (candidate.matching_keys ?? []).some((candidateKey: Any) => externalKeys.has(key(candidateKey))),
    );
    let difference_reason_code: Reconciliation["difference_reason_code"] = "matched";
    if (item.privacy_effect === "redaction") difference_reason_code = "redaction_caused_recalculation";
    else if (item.provider_modeled_without_candidate && !matched.length) difference_reason_code = "provider_modeled_conversion";
    else if (!externalKeys.size) difference_reason_code = "join_key_missing";
    else if (!matched.length && (item.matching_keys ?? []).some((entry: Any) =>
      ["provider_click_id", "provider_install_id"].includes(entry.type))) difference_reason_code = "candidate_missing";
    else if (!matched.length) difference_reason_code = "external_row_unmatched";
    else if (matched.length > 1 && item.matching_keys.some((entry: Any) => entry.cardinality === "one_to_one")) difference_reason_code = "join_key_ambiguous";
    else if (matched[0].excluded) difference_reason_code = "candidate_excluded";
    else if (matched[0].window_status === "out_of_window") difference_reason_code = "window_mismatch";
    else if (matched[0].freshness === "stale") difference_reason_code = "freshness_mismatch";
    const sortedKeys = [...(item.matching_keys ?? [])].sort((a, b) => compareText(key(a), key(b)));
    return {
      reconciliation_id: item.reconciliation_id,
      tenant_id: item.tenant_id,
      app_id: item.app_id,
      input_snapshot_id: item.input_snapshot_id,
      external_snapshot_id: item.external_snapshot_id,
      difference_reason_code,
      difference_reason_version: difference_reason_code === "provider_modeled_conversion" ? "0.4.0" : CONTRACT_VERSION,
      matching_keys: sortedKeys,
      candidates: matched.map((candidate: Any) => candidate.candidate_id).sort(compareText),
      exclusions: matched.filter((candidate: Any) => candidate.excluded).map((candidate: Any) => candidate.exclusion_reason).sort(compareText),
      windows: matched.map((candidate: Any) => `${candidate.candidate_id}:${candidate.window_status}`).sort(compareText),
      joins: matched.map((candidate: Any) => `${sortedKeys.map(key).join(",")}=>${candidate.candidate_id}`).sort(compareText),
      freshness: matched[0]?.freshness ?? item.freshness,
    };
  });
  return sortByKey(output, (result) => [result.reconciliation_id, result.tenant_id, result.app_id]);
}
