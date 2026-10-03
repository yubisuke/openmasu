import { DEFAULT_FRAUD_BUNDLE, fraudBundleHash, fraudNumberParameter, sha256Jcs, type FraudBundle } from "@openmasu/fraud-rules";
import { nonFraudBundleHash } from "@openmasu/contracts/definitions";
import { REFERENCE_RULE_VERSION, type Any } from "./evaluation-model.js";
import { time } from "./evaluation-utils.js";

export const FRAUD_BUNDLE: FraudBundle = DEFAULT_FRAUD_BUNDLE;
export const FRAUD_BUNDLE_HASH = fraudBundleHash(FRAUD_BUNDLE);

export function boundNonFraudBundle(server: Any, id: "attribution-default" | "apple-postback-default"): {
  rule_bundle_id: string; rule_bundle_version: string; rule_bundle_hash: string;
} {
  const expectedVersion = REFERENCE_RULE_VERSION;
  const expectedHash = nonFraudBundleHash(id);
  const bound = server.non_fraud_rule_bundles?.[id];
  if (!bound) return { rule_bundle_id: id, rule_bundle_version: expectedVersion, rule_bundle_hash: expectedHash };
  if (bound.rule_bundle_id !== id || bound.rule_bundle_version !== expectedVersion
    || bound.rule_bundle_hash !== expectedHash || bound.definition_digest !== expectedHash) {
    throw new Error("non_fraud_rule_bundle_binding_mismatch");
  }
  return { rule_bundle_id: id, rule_bundle_version: expectedVersion, rule_bundle_hash: expectedHash };
}

export type BoundFraudBundle = { readonly definition: FraudBundle; readonly hash: string };

export function boundFraudBundle(server: Any): BoundFraudBundle | undefined {
  if (server.fraud_enabled === false) return undefined;
  const bound = server.fraud_rule_bundle;
  if (!bound) return { definition: FRAUD_BUNDLE, hash: FRAUD_BUNDLE_HASH };
  const definition = bound.definition as FraudBundle;
  const hash = fraudBundleHash(definition);
  if (bound.rule_bundle_id !== definition.id || bound.rule_bundle_version !== definition.version) {
    throw new Error("fraud_rule_bundle_identity_mismatch");
  }
  if (bound.definition_digest !== sha256Jcs(definition)) throw new Error("fraud_rule_bundle_definition_digest_mismatch");
  if (bound.rule_bundle_hash !== hash) throw new Error("fraud_rule_bundle_hash_mismatch");
  return { definition, hash };
}

export function quarantineDeadline(action: string, evaluatedAt: string, bundle: FraudBundle): Record<string, string> {
  if (action !== "quarantine") return {};
  const hours = fraudNumberParameter(bundle, "quarantine_hours", 72);
  return { resolution_deadline_at: new Date(time(evaluatedAt, "evaluated_at") + hours * 3_600_000).toISOString() };
}
