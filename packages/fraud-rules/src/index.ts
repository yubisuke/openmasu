import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type FraudAction = "allow" | "flag" | "exclude" | "quarantine";
export type FraudRuleHit = {
  ruleId: string;
  decision: "clear" | "suspected" | "confirmed";
  action: FraudAction;
  reasonCode: "click_injection_suspected" | "ctit_clock_anomaly" | "referrer_time_inconsistent" | "click_flooding_suspected";
  evidenceType: "ctit_category" | "ctit_clock_diagnostic" | "server_clock_order" | "source_day_distribution";
};

export type ClickInjectionPolicy = {
  threshold_seconds: number;
  authority: "server";
  policy_version: string;
  policy_digest: string;
};

export type InstallRuleInput = {
  installBeginAtServer?: string;
  referrerClickAtServer?: string;
  referrerClickAtServerStatus?: "available" | "missing" | "invalid";
  redirectorClickAt?: string;
  policy: ClickInjectionPolicy;
  bundle?: FraudBundle;
};

export type SourceDayInput = {
  clicks: number;
  installs: number;
  medianCvr: number;
  ctitP50Ms?: number;
  ctitP95Ms?: number;
};

export type FraudBundle = {
  id: string;
  version: string;
  layers: {
    base: Record<string, unknown>;
    operator?: Record<string, unknown>;
    private?: Record<string, unknown>;
  };
  rules: readonly { id: string; inputs: readonly string[]; action: FraudAction }[];
};

/**
 * Contract fixtures use this checked-in definition when no runtime revision is
 * supplied. Production ingestion registers and resolves the same shape through
 * control.rule_bundle_revisions before evaluation.
 */
export const DEFAULT_FRAUD_BUNDLE: FraudBundle = {
  id: "fraud-conservative",
  version: "1.0.0",
  layers: { base: {
    ctit_lower_bound_seconds: 10,
    ctit_negative_rate_threshold: 0.05,
    referrer_redirector_divergence_seconds: 300,
    source_day_min_clicks: 1_000,
    source_day_cvr_median_multiplier: 0.2,
    source_day_ctit_p50_min_seconds: 86_400,
    source_day_ctit_p95_p50_max_ratio: 3,
    quarantine_hours: 72,
  } },
  rules: [
    { id: "transport-bot-prefetch-v1", inputs: ["prefetch_signal"], action: "exclude" },
    { id: "transport-replay-v1", inputs: ["replay_signal"], action: "exclude" },
    { id: "referrer-server-order-v1", inputs: ["referrer_click_at_server", "install_begin_at_server"], action: "flag" },
    { id: "ctit-lower-bound-v1", inputs: ["redirector_click_at", "install_begin_at_server"], action: "flag" },
    { id: "ctit-clock-anomaly-v1", inputs: ["redirector_click_at", "install_begin_at_server"], action: "allow" },
    { id: "referrer-redirector-divergence-v1", inputs: ["referrer_click_at_server", "redirector_click_at"], action: "flag" },
    { id: "source-day-click-flooding-v1", inputs: ["source_day_aggregate"], action: "flag" },
    { id: "device-integrity-combination-v1", inputs: ["integrity_verdict", "ctit"], action: "flag" },
  ],
};

export function sha256Jcs(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function clickInjectionPolicyDigest(policy: Omit<ClickInjectionPolicy, "policy_digest">): string {
  return sha256Jcs(policy);
}

export function assertClickInjectionPolicy(policy: ClickInjectionPolicy): void {
  const expected = clickInjectionPolicyDigest({
    threshold_seconds: policy.threshold_seconds,
    authority: policy.authority,
    policy_version: policy.policy_version,
  });
  if (policy.policy_digest !== expected) throw new Error("click_injection_policy.policy_digest does not match its canonical policy fields");
}

function instant(value: string): number {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed.getTime() : Number.NaN;
}

export function evaluateInstallRules(input: InstallRuleInput): readonly FraudRuleHit[] {
  assertClickInjectionPolicy(input.policy);
  const bundle = input.bundle ?? DEFAULT_FRAUD_BUNDLE;
  const output: FraudRuleHit[] = [];
  if (input.referrerClickAtServerStatus === "available" && input.referrerClickAtServer && input.installBeginAtServer) {
    if (instant(input.referrerClickAtServer) >= instant(input.installBeginAtServer) + 1_000) {
      output.push({
        ruleId: "referrer-server-order-v1",
        decision: "confirmed",
        action: fraudRuleAction(bundle, "referrer-server-order-v1", "flag"),
        reasonCode: "referrer_time_inconsistent",
        evidenceType: "server_clock_order",
      });
    }
  }
  if (input.redirectorClickAt && input.installBeginAtServer) {
    const delta = instant(input.installBeginAtServer) - instant(input.redirectorClickAt);
    if (delta < 0) {
      output.push({
        ruleId: "ctit-clock-anomaly-v1",
        decision: "clear",
        action: "allow",
        reasonCode: "ctit_clock_anomaly",
        evidenceType: "ctit_clock_diagnostic",
      });
      return output;
    }
    if (delta < input.policy.threshold_seconds * 1_000) {
      output.push({
        ruleId: "ctit-lower-bound-v1",
        decision: "suspected",
        action: fraudRuleAction(bundle, "ctit-lower-bound-v1", "flag"),
        reasonCode: "click_injection_suspected",
        evidenceType: "ctit_category",
      });
    }
    const divergenceMilliseconds = fraudNumberParameter(bundle, "referrer_redirector_divergence_seconds", 300) * 1_000;
    if (input.referrerClickAtServer
      && Math.abs(instant(input.referrerClickAtServer) - instant(input.redirectorClickAt)) > divergenceMilliseconds) {
      output.push({
        ruleId: "referrer-redirector-divergence-v1",
        decision: "suspected",
        action: fraudRuleAction(bundle, "referrer-redirector-divergence-v1", "flag"),
        reasonCode: "referrer_time_inconsistent",
        evidenceType: "server_clock_order",
      });
    }
  }
  return output;
}

export function evaluateSourceDay(input: SourceDayInput): FraudRuleHit | undefined {
  return evaluateSourceDayWithBundle(input, DEFAULT_FRAUD_BUNDLE);
}

export function fraudNumberParameter(bundle: FraudBundle, name: string, fallback: number): number {
  const value = bundle.layers.base[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function fraudRuleAction(bundle: FraudBundle, ruleId: string, fallback: FraudAction): FraudAction {
  return bundle.rules.find((rule) => rule.id === ruleId)?.action ?? fallback;
}

export function evaluateSourceDayWithBundle(input: SourceDayInput, bundle: FraudBundle): FraudRuleHit | undefined {
  const minimumClicks = fraudNumberParameter(bundle, "source_day_min_clicks", 1_000);
  const cvrMultiplier = fraudNumberParameter(bundle, "source_day_cvr_median_multiplier", 0.2);
  const p50MinimumMs = fraudNumberParameter(bundle, "source_day_ctit_p50_min_seconds", 86_400) * 1_000;
  const p95P50MaximumRatio = fraudNumberParameter(bundle, "source_day_ctit_p95_p50_max_ratio", 3);
  if (input.clicks < minimumClicks || input.installs / input.clicks > input.medianCvr * cvrMultiplier ||
      input.ctitP50Ms === undefined || input.ctitP50Ms < p50MinimumMs ||
      input.ctitP95Ms === undefined || input.ctitP95Ms / input.ctitP50Ms > p95P50MaximumRatio) return undefined;
  return {
    ruleId: "source-day-click-flooding-v1",
    decision: "suspected",
    action: fraudRuleAction(bundle, "source-day-click-flooding-v1", "flag"),
    reasonCode: "click_flooding_suspected",
    evidenceType: "source_day_distribution",
  };
}

export function assertFraudBundle(bundle: FraudBundle): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(bundle.id)) throw new Error("fraud_bundle_id_invalid");
  if (bundle.version.length < 1 || bundle.version.length > 128) throw new Error("fraud_bundle_version_invalid");
  if (!bundle.layers || typeof bundle.layers.base !== "object" || Array.isArray(bundle.layers.base)) {
    throw new Error("fraud_bundle_layers_invalid");
  }
  if (!Array.isArray(bundle.rules) || bundle.rules.length === 0) throw new Error("fraud_bundle_rules_invalid");
  if (bundle.layers.private) {
    const keys = Object.keys(bundle.layers.private);
    if (keys.length !== 1 || keys[0] !== "digest"
      || !/^[a-f0-9]{64}$/.test(String(bundle.layers.private.digest ?? ""))) {
      throw new Error("fraud_bundle_private_layer_must_be_digest_only");
    }
  }
  for (const rule of bundle.rules) {
    if (!/^[a-z][a-z0-9-]{2,127}$/.test(rule.id) || !Array.isArray(rule.inputs)
      || !["allow", "flag", "exclude", "quarantine"].includes(rule.action)) {
      throw new Error(`fraud_bundle_rule_invalid:${String(rule.id)}`);
    }
    if (rule.inputs.length > 0 && rule.inputs.every((input: string) => input === "integrity_verdict")) {
      throw new Error(`integrity_only_rule_forbidden:${rule.id}`);
    }
  }
}

export function fraudBundleHash(bundle: FraudBundle): string {
  assertFraudBundle(bundle);
  return sha256Jcs({ id: bundle.id, version: bundle.version, layers: bundle.layers, rules: bundle.rules });
}

export function publicBundleProvenance(bundle: FraudBundle): {
  id: string; version: string; hash: string; private_layer_digest?: string;
} {
  return {
    id: bundle.id,
    version: bundle.version,
    hash: fraudBundleHash(bundle),
    ...(bundle.layers.private ? { private_layer_digest: String(bundle.layers.private.digest) } : {}),
  };
}
