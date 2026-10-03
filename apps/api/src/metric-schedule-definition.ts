import type { MetricScheduleDefinition } from "./metric-schedules.js";

/** Pure request projection: derived checkpoint metadata is never a caller-controlled field. */
export function metricScheduleRequestDefinition(definition: MetricScheduleDefinition): Omit<MetricScheduleDefinition,"cohort_time_zone"> {
  const {cohort_time_zone: _derivedZone,...request} = definition;
  return request;
}
