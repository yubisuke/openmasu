/** Closed, non-secret audit projection. Never pass a complete definition here. */
export const configurationKinds = ["cost_schedule", "metric_schedule", "import_mapping", "webhook_content", "google_destination", "attribution_window"] as const;
export type ConfigurationKind = typeof configurationKinds[number];
export type ConfigurationFields = Readonly<Record<string, string | number | boolean>>;
export type ConfigurationChange = {
  kind: ConfigurationKind;
  before_revision: string | null;
  after_revision: string;
  before: ConfigurationFields | null;
  after: ConfigurationFields;
};

const enums: Record<string, readonly string[]> = {
  status: ["active", "disabled"], kind: ["mmp_raw", "manual_cost"],
  mode: ["legacy_v1", "explicit_v1"], app_audience: ["general", "mixed", "child_directed"],
  provider: ["google_ads", "apple_ads"],
};
const numbers = new Set(["lag_days", "metric_count", "evaluation_count", "header_count", "custom_event_count", "renamed_event_count", "lookback_days"]);
const booleans = new Set(["share_money", "enabled", "ready"]);
function fields(value: unknown): value is ConfigurationFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, item]) => {
    if (numbers.has(key)) return typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
    if (booleans.has(key)) return typeof item === "boolean";
    if (Object.hasOwn(enums, key)) return typeof item === "string" && enums[key].includes(item);
    if (key === "definition_digest") return typeof item === "string" && /^[a-f0-9]{64}$/.test(item);
    if (key === "start_date") return typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item);
    if (key === "currency") return typeof item === "string" && /^[A-Z]{3}$/.test(item);
    return false;
  });
}
const revision = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(value);
export function parseConfigurationChange(value: unknown): ConfigurationChange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "after,after_revision,before,before_revision,kind"
    || !configurationKinds.includes(row.kind as ConfigurationKind) || !revision(row.after_revision)
    || !(row.before_revision === null && row.before === null || revision(row.before_revision) && fields(row.before))
    || !fields(row.after)) return null;
  return row as ConfigurationChange;
}
export function configurationChange(kind: ConfigurationKind, beforeRevision: string | null, before: ConfigurationFields | null,
  afterRevision: string, after: ConfigurationFields): ConfigurationChange {
  const result = parseConfigurationChange({ kind, before_revision: beforeRevision, before, after_revision: afterRevision, after });
  if (!result) throw Error("configuration_audit_projection_invalid");
  return result;
}
export function configurationDifferences(change: ConfigurationChange) {
  return [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after)])].sort()
    .filter(field => change.before?.[field] !== change.after[field])
    .map(field => ({ field, before: change.before?.[field] ?? null, after: change.after[field] ?? null }));
}

export function metricConfigurationFields(value: { lag_days: number; start_date: string; definition_digest: string;
  definition: { metric_definitions: readonly unknown[]; evaluations: readonly unknown[] } }): ConfigurationFields {
  return { lag_days: value.lag_days, start_date: value.start_date, definition_digest: value.definition_digest,
    metric_count: value.definition.metric_definitions.length, evaluation_count: value.definition.evaluations.length };
}
export function webhookConfigurationFields(value: { mode: string; share_money?: boolean; custom_events?: Record<string, string>; event_names?: Record<string, string> }, digest: string): ConfigurationFields {
  return { mode: value.mode, definition_digest: digest, ...(value.mode === "explicit_v1" ? {
    share_money: value.share_money!, custom_event_count: Object.keys(value.custom_events!).length,
    renamed_event_count: Object.keys(value.event_names!).length,
  } : {}) };
}
