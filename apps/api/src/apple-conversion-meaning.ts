/** Small opt-in encoding, not an arbitrary rule DSL or a postback-to-schema binding. */
export type ConversionMeaning = {
  profile: "event_revenue_v1"; schema_version: string;
  effective_from: string; effective_to: string;
  event_keys: string[];
  revenue: { event_key: string; currency: string; amount_scale: number; thresholds: string[] };
  coarse: { medium_from: number; high_from: number };
  lock_at_maximum: boolean;
};
const invalid = (): never => { throw new Error("conversion_meaning_invalid"); };
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.exec(value)?.[0] === value;
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join("|") !== [...keys].sort().join("|")) return invalid();
  return result;
}
function day(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function parseConversionMeaning(value: unknown): ConversionMeaning {
  const v = object(value, ["profile", "schema_version", "effective_from", "effective_to", "event_keys", "revenue", "coarse", "lock_at_maximum"]);
  if (v.profile !== "event_revenue_v1" || !matches(v.schema_version, /^\d+\.\d+\.\d+$/)
    || !day(v.effective_from) || !day(v.effective_to) || v.effective_from >= v.effective_to
    || typeof v.lock_at_maximum !== "boolean" || !Array.isArray(v.event_keys) || v.event_keys.length < 1 || v.event_keys.length > 3
    || v.event_keys.some(key => !matches(key, /^[a-z][a-z0-9_]{1,47}$/))
    || new Set(v.event_keys).size !== v.event_keys.length) return invalid();
  const revenue = object(v.revenue, ["event_key", "currency", "amount_scale", "thresholds"]);
  const coarse = object(v.coarse, ["medium_from", "high_from"]);
  if (!v.event_keys.includes(revenue.event_key) || !matches(revenue.currency, /^[A-Z]{3}$/)
    || !Number.isInteger(revenue.amount_scale) || Number(revenue.amount_scale) < 0 || Number(revenue.amount_scale) > 6
    || !Array.isArray(revenue.thresholds) || revenue.thresholds.length < 2 || revenue.thresholds.length > 8
    || revenue.thresholds[0] !== "0"
    || revenue.thresholds.some(x => !matches(x, /^(0|[1-9][0-9]{0,14})$/))) return invalid();
  if (revenue.thresholds.some((x, i, a) => i > 0 && BigInt(x) <= BigInt(a[i - 1]))) return invalid();
  const size = 2 ** v.event_keys.length * revenue.thresholds.length;
  if (size > 64 || !Number.isInteger(coarse.medium_from) || !Number.isInteger(coarse.high_from)
    || Number(coarse.medium_from) < 1 || Number(coarse.high_from) <= Number(coarse.medium_from)
    || Number(coarse.high_from) >= size) return invalid();
  return value as ConversionMeaning;
}
export function meaningUpdate(schema: ConversionMeaning, eventMask: number, revenue: bigint) {
  const bucket = schema.revenue.thresholds.filter(value => BigInt(value) <= revenue).length - 1;
  const fine_value = eventMask + (2 ** schema.event_keys.length) * bucket;
  return { fine_value, coarse_value: fine_value >= schema.coarse.high_from ? "high" : fine_value >= schema.coarse.medium_from ? "medium" : "low",
    lock_postback: schema.lock_at_maximum && fine_value === (2 ** schema.event_keys.length * schema.revenue.thresholds.length) - 1 };
}
export type DecodedMeaning = { state: "unverified"; reason: string; possible_meanings?: {
  fine_value: number; event_keys_observed: string[];
  revenue_range: { lower_inclusive: string; upper_exclusive: string | null; currency: string; amount_scale: number };
}[] };
export function decodeConversionMeaning(schema: ConversionMeaning, bucket: string, protocol: string, sequence: string, conversionType: string): DecodedMeaning {
  if (!["skan_4", "adattributionkit"].includes(protocol) || !["0", "1", "2"].includes(sequence)
    || !["download", "redownload"].includes(conversionType) || bucket.startsWith("fine:") && sequence !== "0") return { state: "unverified", reason: "unsupported_window_or_type" };
  const size = 2 ** schema.event_keys.length * schema.revenue.thresholds.length;
  const values = Array.from({ length: size }, (_, fine) => fine)
    .filter(fine => fine < 2 ** schema.event_keys.length || (fine & 2 ** schema.event_keys.indexOf(schema.revenue.event_key)) !== 0)
    .filter(fine => bucket === `fine:${fine}`
    || bucket === `coarse:${meaningUpdate(schema, fine % 2 ** schema.event_keys.length,
      BigInt(schema.revenue.thresholds[Math.floor(fine / 2 ** schema.event_keys.length)])).coarse_value}`);
  if (!values.length) return { state: "unverified", reason: bucket === "absent" || bucket === "not_recorded" ? "value_absent" : "value_outside_definition" };
  return { state: "unverified", reason: "operator_selected_definition_not_postback_bound", possible_meanings: values.map(fine => {
    const revenueBucket = Math.floor(fine / 2 ** schema.event_keys.length);
    return { fine_value: fine, event_keys_observed: schema.event_keys.filter((_, index) => (fine & 2 ** index) !== 0),
      revenue_range: { lower_inclusive: schema.revenue.thresholds[revenueBucket], upper_exclusive: schema.revenue.thresholds[revenueBucket + 1] ?? null,
        currency: schema.revenue.currency, amount_scale: schema.revenue.amount_scale } };
  }) };
}
