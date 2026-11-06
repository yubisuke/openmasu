import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import { FIRST_PARTY_WINDOW_BUNDLE } from "@openmasu/contracts/definitions";
import { configurationDifferences, parseConfigurationChange, type ConfigurationChange } from "./configuration-change.js";

const actions = ["cost_schedule_registered", "cost_schedule_disabled", "metric_schedule_registered", "metric_schedule_disabled",
  "metric_schedule_replaced", "import_mapping_revision_registered", "operator_webhook_content_activated",
  "operator_webhook_destination_registered", "google_destination_activated", "rule_bundle_activated", "rule_bundle_superseded"];
export class ConfigurationHistoryQueryError extends Error {
  constructor() { super("configuration_history_query_invalid"); }
}
type Cursor = { occurred_at: string; audit_log_id: string };
export function parseConfigurationHistoryQuery(params: URLSearchParams) {
  const invalid = (): never => { throw new ConfigurationHistoryQueryError(); };
  if ([...params.keys()].some(key => !["limit", "after"].includes(key) || params.getAll(key).length !== 1)) invalid();
  const rawLimit = params.get("limit") ?? "50";
  if (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 100) invalid();
  let after: Cursor | undefined;
  const token = params.get("after");
  if (token !== null) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) invalid();
    try {
      const value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      if (!value || Object.keys(value).sort().join(",") !== "audit_log_id,occurred_at"
        || typeof value.occurred_at !== "string" || new Date(value.occurred_at).toISOString() !== value.occurred_at
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.audit_log_id)) invalid();
      after = value;
    } catch { invalid(); }
  }
  return { limit: Number(rawLimit), ...(after ? { after } : {}) };
}
export type ConfigurationHistoryRow = Cursor & {
  app_id: string; actor_ref: string; action: string; target_scope: string; target_ref: string; outcome: string;
  change_state: "failed" | "details_not_recorded" | "fields_changed" | "revision_only";
  change: ConfigurationChange | null;
};
export type ConfigurationHistoryPage = { data: ConfigurationHistoryRow[]; next_cursor: string | null };
export async function configurationHistory(pool: Pool, identity: { tenantId: string; appId: string },
  query: ReturnType<typeof parseConfigurationHistoryQuery>): Promise<ConfigurationHistoryPage> {
  return withTenant(pool, identity.tenantId, async client => {
    const result = await client.query<Omit<ConfigurationHistoryRow, "change" | "change_state"> & { configuration_change: unknown }>(
      `SELECT audit.audit_log_id::text,audit.occurred_at,audit.app_id,audit.actor_ref,audit.action,
         audit.target_scope,audit.target_ref,audit.outcome,audit.configuration_change
       FROM ledger.audit_logs AS audit
       WHERE audit.tenant_id=$1 AND audit.app_id=$2 AND audit.actor_type='admin_key' AND audit.action=ANY($3::text[])
         AND (audit.action NOT IN ('rule_bundle_activated','rule_bundle_superseded') OR EXISTS (
           SELECT 1 FROM control.rule_bundle_revisions AS revision WHERE revision.tenant_id=$1 AND revision.app_id=$2
             AND revision.rule_bundle_revision_id=audit.target_ref AND revision.rule_bundle_id=$4))
         AND (audit.action<>'metric_schedule_registered' OR NOT EXISTS (
           SELECT 1 FROM control.metric_schedules AS schedule WHERE schedule.tenant_id=$1 AND schedule.app_id=$2
             AND schedule.metric_schedule_id=audit.target_ref AND schedule.artifact ? 'replacement'))
         AND ($5::text IS NULL OR (audit.occurred_at,audit.audit_log_id)<($5::text,$6::uuid))
       ORDER BY audit.occurred_at DESC,audit.audit_log_id DESC LIMIT $7`,
      [identity.tenantId, identity.appId, actions, FIRST_PARTY_WINDOW_BUNDLE,
        query.after?.occurred_at ?? null, query.after?.audit_log_id ?? null, query.limit + 1]);
    const data = result.rows.slice(0, query.limit).map(({ configuration_change, ...row }): ConfigurationHistoryRow => {
      const change = row.outcome === "succeeded" ? parseConfigurationChange(configuration_change) : null;
      return { ...row, change, change_state: row.outcome !== "succeeded" ? "failed" : !change ? "details_not_recorded"
        : configurationDifferences(change).length ? "fields_changed" : "revision_only" };
    });
    const last = data.at(-1);
    return { data, next_cursor: result.rows.length > query.limit && last
      ? Buffer.from(JSON.stringify({ occurred_at: last.occurred_at, audit_log_id: last.audit_log_id })).toString("base64url") : null };
  });
}
