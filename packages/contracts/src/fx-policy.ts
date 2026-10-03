/** Opt-in, captured rates. No lookup, inferred identity rate or current-time fallback. */
export const DATED_FX_POLICY_VERSION = "0.4.22";
export const DATED_FX_RATE_SELECTION = "utc_event_date_and_cost_date";

export type DatedFxRate = {
  currency: string;
  effective_date: string;
  rate_unscaled: string;
  rate_scale: number;
  source: string;
  as_of: string;
};
export type DatedFxPolicyInput = {
  policy_version: typeof DATED_FX_POLICY_VERSION;
  target_currency: string;
  target_scale: number;
  rounding_mode: "half_even";
  rate_selection: typeof DATED_FX_RATE_SELECTION;
  rates: DatedFxRate[];
};

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exactDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000-")) return false;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith("0000-") && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function scale(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 18;
}

export function validDatedFxPolicy(value: unknown): value is DatedFxPolicyInput {
  if (!object(value) || Object.keys(value).some(key => ![
    "policy_version", "target_currency", "target_scale", "rounding_mode", "rate_selection", "rates",
  ].includes(key)) || value.policy_version !== DATED_FX_POLICY_VERSION
      || value.rate_selection !== DATED_FX_RATE_SELECTION || value.rounding_mode !== "half_even"
      || typeof value.target_currency !== "string" || !/^[A-Z]{3}$/.test(value.target_currency)
      || !scale(value.target_scale) || !Array.isArray(value.rates)
      || value.rates.length < 1 || value.rates.length > 128) return false;
  const keys = new Set<string>();
  for (const rate of value.rates) {
    if (!object(rate) || Object.keys(rate).some(key => ![
      "currency", "effective_date", "rate_unscaled", "rate_scale", "source", "as_of",
    ].includes(key)) || typeof rate.currency !== "string" || !/^[A-Z]{3}$/.test(rate.currency)
        || !exactDate(rate.effective_date) || typeof rate.rate_unscaled !== "string"
        || !/^[1-9][0-9]{0,77}$/.test(rate.rate_unscaled) || !scale(rate.rate_scale)
        || typeof rate.source !== "string" || rate.source.length < 1 || rate.source.length > 128
        || !timestamp(rate.as_of)) return false;
    const key = `${rate.currency}:${rate.effective_date}`;
    if (keys.has(key)) return false;
    keys.add(key);
    // Even same-currency evidence must be explicit and cannot alter its unit.
    if (rate.currency === value.target_currency && BigInt(rate.rate_unscaled) !== 10n ** BigInt(rate.rate_scale)) return false;
  }
  return true;
}

export function canonicalDatedFxPolicy(value: unknown): DatedFxPolicyInput {
  if (!validDatedFxPolicy(value)) throw new Error("dated_fx_policy_invalid");
  const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return {
    policy_version: value.policy_version, target_currency: value.target_currency, target_scale: value.target_scale,
    rounding_mode: value.rounding_mode, rate_selection: value.rate_selection,
    rates: value.rates.map(rate => ({ currency: rate.currency, effective_date: rate.effective_date,
      rate_unscaled: rate.rate_unscaled, rate_scale: rate.rate_scale, source: rate.source, as_of: rate.as_of }))
      .sort((a, b) => order(a.currency, b.currency) || order(a.effective_date, b.effective_date)),
  };
}

export function selectDatedFxRate(policy: DatedFxPolicyInput, currency: string, date: string, watermark: string): DatedFxRate | undefined {
  return policy.rates.find(rate => rate.currency === currency && rate.effective_date === date
    && Date.parse(rate.as_of) <= Date.parse(watermark));
}

/** Safe aggregate projection for reports; never spread an arbitrary stored artifact. */
export function projectDatedFxSnapshot(value: unknown): { policy: DatedFxPolicyInput; snapshot_id: string } | undefined {
  if (!object(value) || typeof value.snapshot_id !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshot_id)
      || !validDatedFxPolicy(value.policy)) return undefined;
  return { policy: canonicalDatedFxPolicy(value.policy), snapshot_id: value.snapshot_id };
}
