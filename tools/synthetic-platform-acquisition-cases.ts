import { sha256 } from "@openmasu/attribution-core/canonical";
type Any = Record<string, any>;
export type PlatformCase = { name: string; input: Any; expected: string[] };
const baseline = ["1","2000000","no_attributed_cost","1000000", "0","empty_cohort","0","empty_cohort", "0",
  "1","5000000","500000","1000000", "1","2000000","2000000","1000000", "1"];
const withoutMeta = ["0","empty_cohort","no_attributed_cost","empty_cohort", ...baseline.slice(4,13), "0","empty_cohort","0","empty_cohort", "1"];
/** Values are hand-computed, not copied from either evaluator or SQL. */
export function syntheticPlatformAcquisitionCases(source: Any): PlatformCase[] {
  const build = (name: string, mutation: (input: Any) => void, expected = baseline): PlatformCase => {
    const input = structuredClone(source); mutation(input); return { name, input, expected: [...expected] };
  };
  const meta = (input: Any) => input.platform_acquisition_inputs.find((proof: Any) => proof.source === "meta_install_referrer");
  const install = (input: Any) => input.batches.flatMap((batch: Any) => batch.records).find((record: Any) => record.record_id === "meta-66");
  return [
    build("keeps verified sources, late cutoff, negative attribution and parent-cost absence distinct", () => {}),
    build("does not adopt device context without a trusted server projection", input => { input.platform_acquisition_inputs = []; },
      ["0","empty_cohort","no_attributed_cost","empty_cohort", "0","empty_cohort","0","empty_cohort", "0", "0","empty_cohort","0","empty_cohort", "0","empty_cohort","0","empty_cohort", "0"]),
    build("does not adopt a projection from another tenant", input => { meta(input).attribution.tenant_id = "tenant-b"; }, withoutMeta),
    build("does not adopt an attribution input cutoff after the watermark", input => {
      input.platform_acquisition_inputs.find((proof: Any) => proof.install_record_id === "apple-66").attribution.input_cutoff_at = "2026-10-02T00:00:00.000Z";
    }, [...baseline.slice(0,9), "0","empty_cohort","0","empty_cohort", ...baseline.slice(13)]),
    build("does not fall back after protected context redaction", input => { meta(input).lifecycle_status = "redacted"; }, withoutMeta),
    build("does not fall back after protected context retention expiry", input => { meta(input).lifecycle_status = "purged"; }, withoutMeta),
    build("rejects a changed protected context digest", input => { meta(input).evidence_digest = "0".repeat(64); }, withoutMeta),
    build("rejects a claimed decryption without its canonical server marker", input => {
      delete install(input).payload.extensions.meta_decryption_key_id;
      meta(input).evidence_digest = sha256(install(input).payload);
    }, withoutMeta),
    build("keeps equal campaign IDs in different source namespaces separate", input => {
      const campaign = "2066"; install(input).payload.meta_referrer_context.campaign_id = campaign;
      meta(input).context.campaign_id = campaign; meta(input).evidence_digest = sha256(install(input).payload);
      for (const evaluation of input.metric_evaluations) if (evaluation.grouping.network === "meta_install_referrer") evaluation.grouping.campaign_id = campaign;
      const cost = input.cost_records.find((row: Any) => row.network === "meta_install_referrer");
      cost.campaign_id = campaign;
      cost.dimension_digest = sha256({ network: cost.network, campaign_id: campaign });
    }),
    build("is stable under record, proof, definition, cost and evaluation permutations", input => {
      for (const field of ["batches","platform_acquisition_inputs","metric_definitions","cost_records","metric_evaluations"]) input[field].reverse();
    }),
    build("uses the selected platform exclusion for net cohorts without changing gross definitions", input => {
      const attribution = meta(input).attribution;
      attribution.reason_code = "fraud_excluded";
      attribution.supersedes_attribution_id = attribution.attribution_id;
      attribution.attribution_id = "attr:meta-net-excluded-66";
      attribution.decided_at = attribution.input_cutoff_at = "2026-09-29T11:00:00.000Z";
      for (const definition of input.metric_definitions) if (definition.acquisition_basis === "selected_verified_platform") definition.fraud_policy = "net";
    }, withoutMeta),
  ];
}
