import { normalizeMetricRecalculationRequest, type CostRecalculationRequest } from "@openmasu/runtime";

const fields = ["cost_import_run_id", "date_from", "date_to", "watermark", "metric_names"] as const;

/** Transport decoding only. The API normalizer and request service own limits and selection. */
export function metricRecalculationFormRequest(form: URLSearchParams): CostRecalculationRequest {
  if ([...form.keys()].some(key => !["csrf_token", ...fields].includes(key) || form.getAll(key).length !== 1)) {
    throw new Error("metric_recalculation_form_invalid");
  }
  const names = (form.get("metric_names") ?? "").trim();
  const request = normalizeMetricRecalculationRequest({
    cost_import_run_id: form.get("cost_import_run_id"), date_from: form.get("date_from"),
    date_to: form.get("date_to"), watermark: form.get("watermark"),
    ...(names ? { metric_names: names.split(/[\s,]+/) } : {}),
  });
  if (request.trigger_kind === "late_events") throw new Error("metric_recalculation_form_invalid");
  return request;
}
