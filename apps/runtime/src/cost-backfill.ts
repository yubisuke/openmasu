import { sha256 } from "@openmasu/attribution-core/canonical";

export type CostBackfillRequest = { cost_schedule_id: string; dates: string[]; retry_of?: string };
export type CostBackfillConfiguration = { provider: "google_ads" | "apple_ads"; api_version: string; currency: string;
  lag_days: number; limits: Record<string, number> };
export type CostBackfillDay = { date: string; state: string; eligible: boolean; row_count: number | null;
  import_run_id: string | null; safe_reason: string | null; history_ref: string | null };
export type CostBackfillPlan = CostBackfillRequest & { definition_digest: string; as_of: string;
  configuration: CostBackfillConfiguration; days: CostBackfillDay[]; receipt: string;
  confirmation: CostBackfillRequest & { as_of: string; receipt: string } };

export function costBackfillDay(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error("cost_backfill_dates_invalid");
  }
  return value;
}
export function costBackfillDates(from: unknown, to: unknown): string[] {
  const since = costBackfillDay(from), until = costBackfillDay(to), start = Date.parse(since), end = Date.parse(until);
  const count = (end - start) / 86400000 + 1;
  if (count < 1 || count > 31) throw new Error("cost_backfill_dates_invalid");
  return Array.from({ length: count }, (_, index) => new Date(start + index * 86400000).toISOString().slice(0, 10));
}
export function normalizeCostBackfillRequest(value: unknown, confirmation = false): CostBackfillRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cost_backfill_request_invalid");
  const body = value as Record<string, unknown>;
  const allowed = ["cost_schedule_id", "dates", "retry_of", ...(confirmation ? ["receipt", "as_of"] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.cost_schedule_id !== "string"
      || !/^cost-schedule:[A-Za-z0-9-]{1,100}$/.test(body.cost_schedule_id)
      || !Array.isArray(body.dates) || body.dates.length < 1 || body.dates.length > 31
      || new Set(body.dates).size !== body.dates.length
      || body.retry_of !== undefined && (typeof body.retry_of !== "string" || !/^[a-f0-9]{64}$/.test(body.retry_of))) {
    throw new Error("cost_backfill_request_invalid");
  }
  const dates = body.dates.map(costBackfillDay).sort();
  costBackfillDates(dates[0], dates.at(-1));
  return { cost_schedule_id: body.cost_schedule_id, dates, ...(body.retry_of === undefined ? {} : { retry_of: body.retry_of as string }) };
}
export function costBackfillAsOf(value: unknown, now = new Date()): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || Date.parse(value) > now.valueOf()) {
    throw new Error("cost_backfill_as_of_invalid");
  }
  return value;
}
export function costBackfillReceipt(scope: { tenantId: string; appId: string }, plan: Omit<CostBackfillPlan, "receipt" | "confirmation">): string {
  return sha256({ format: "cost-backfill-v1", scope: { tenantId: scope.tenantId, appId: scope.appId }, ...plan });
}
