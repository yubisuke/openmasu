import type { PlatformAcquisitionInput } from "@openmasu/contracts/types";
import { attemptEvidenceKey, evidenceKey } from "./candidates.js";
import type { Attempt, Attribution } from "./evaluation-model.js";
import { compositeKey, sortByKey } from "./evaluation-utils.js";
import { sha256 } from "./canonical.js";

/** Inputs are server projections. Device payload fields alone never establish this basis. */
export function selectPlatformAcquisition(
  attributions: Attribution[], included: Attempt[], inputs: readonly PlatformAcquisitionInput[], watermark: string,
): { attributions: Map<string, Attribution>; proofs: Map<string, PlatformAcquisitionInput> } {
  const records = new Set(included.map(attemptEvidenceKey));
  const installs = included.filter(attempt => attempt.record.event_name === "install" && !attempt.record.producer.startsWith("import:"));
  const subjects = new Set(installs.map(install => compositeKey([install.server.tenant_id, install.server.app_id, install.record.payload.installation_id])));
  const key = (attribution: Attribution) => compositeKey([attribution.tenant_id, attribution.app_id, attribution.attribution_id]);
  const proofs = new Map<string, PlatformAcquisitionInput>();
  const conflicts = new Set<string>();
  for (const input of inputs) {
    const attribution = input.attribution;
    if (attribution.subject_scope !== "installation_level" || attribution.method !== input.source
        || attribution.decided_at > watermark || attribution.input_cutoff_at > watermark
        || !installs.some(install => install.record.record_id === input.install_record_id
          && install.server.tenant_id === attribution.tenant_id && install.server.app_id === attribution.app_id
          && install.record.payload.installation_id === attribution.subject_ref)
        || !attribution.evidence_refs.some(ref => ref.ref === input.install_record_id
          && ref.tenant_id === attribution.tenant_id && ref.app_id === attribution.app_id)) continue;
    const id = key(attribution);
    const install = installs.find(install => install.record.record_id === input.install_record_id
      && install.server.tenant_id === attribution.tenant_id && install.server.app_id === attribution.app_id)!;
    if (input.source === "meta_install_referrer") {
      const payload = install.record.payload;
      if (payload.meta_referrer_status !== "decrypted" || !payload.extensions?.meta_decryption_key_id
          || input.evidence_ref !== payload.protected_referrer_evidence_ref || input.evidence_digest !== sha256(payload)
          || input.context.campaign_id !== payload.meta_referrer_context?.campaign_id
          || input.context.ad_group_id !== payload.meta_referrer_context?.adgroup_id) continue;
    } else if (!attribution.evidence_refs.some(ref => ref.ref === input.evidence_ref)) continue;
    if (proofs.has(id)) conflicts.add(id);
    proofs.set(id, input);
  }
  for (const id of conflicts) proofs.delete(id);
  const candidates = new Map(attributions.map(attribution => [key(attribution), attribution]));
  for (const proof of proofs.values()) candidates.set(key(proof.attribution), proof.attribution);
  const eligible = [...candidates.values()].filter(attribution => attribution.subject_scope === "installation_level"
    && subjects.has(compositeKey([attribution.tenant_id, attribution.app_id, attribution.subject_ref]))
    && attribution.decided_at <= watermark && attribution.input_cutoff_at <= watermark
    && attribution.evidence_refs.every(ref => ref.tenant_id === attribution.tenant_id && ref.app_id === attribution.app_id
      && (records.has(evidenceKey(ref.tenant_id, ref.app_id, ref.ref)) || proofs.get(key(attribution))?.evidence_ref === ref.ref)));
  const superseded = new Set(eligible.filter(attribution => attribution.supersedes_attribution_id)
    .map(attribution => compositeKey([attribution.tenant_id, attribution.app_id, attribution.subject_ref, attribution.supersedes_attribution_id])));
  const selected = new Map(sortByKey(eligible.filter(attribution => !superseded.has(compositeKey([
    attribution.tenant_id, attribution.app_id, attribution.subject_ref, attribution.attribution_id,
  ]))), attribution => [attribution.decided_at, attribution.attribution_id]).map(attribution => [
    compositeKey([attribution.tenant_id, attribution.app_id, attribution.subject_ref]), attribution,
  ]));
  return { attributions: selected, proofs };
}

export function platformAcquisitionDimensions(
  install: Attempt, selection: ReturnType<typeof selectPlatformAcquisition>,
): { campaign_id?: string; ad_group_id?: string; network: string } | undefined {
  const attribution = selection.attributions.get(compositeKey([
    install.server.tenant_id, install.server.app_id, install.record.payload.installation_id,
  ]));
  if (!attribution) return undefined;
  const proof = selection.proofs.get(compositeKey([attribution.tenant_id, attribution.app_id, attribution.attribution_id]));
  if (!proof || proof.lifecycle_status !== "available") return undefined;
  return { ...(attribution.status === "non_organic" ? proof.context : {}), network: proof.source };
}

export function selectedPlatformProofRows(selection: ReturnType<typeof selectPlatformAcquisition>, digest: (value: unknown) => string): string[][] {
  return sortByKey([...selection.attributions.values()], attribution => [attribution.tenant_id, attribution.app_id, attribution.attribution_id])
    .flatMap(attribution => {
      const proof = selection.proofs.get(compositeKey([attribution.tenant_id, attribution.app_id, attribution.attribution_id]));
      return proof ? [[attribution.tenant_id, attribution.app_id, attribution.attribution_id, digest(proof)]] : [];
    });
}
