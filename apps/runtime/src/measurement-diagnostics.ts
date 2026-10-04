/** Closed, non-identifying operational classes; never copy arbitrary transport strings. */
export const MEASUREMENT_PRODUCERS = ["sdk-android", "sdk-ios", "other"] as const;
export const MEASUREMENT_EVENTS = ["click", "install", "session_start", "ad_impression", "ad_view",
  "ad_revenue", "purchase", "refund", "consent_changed", "custom_event", "skan_postback",
  "adattributionkit_postback", "deep_link_open", "other"] as const;
export const MEASUREMENT_SDK_VERSIONS = ["0.1.0", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.3",
  "0.2.0-rc.4", "0.2.0", "0.3.0-rc.1", "other"] as const;
export const measurementGroupLimit = MEASUREMENT_PRODUCERS.length * MEASUREMENT_EVENTS.length * MEASUREMENT_SDK_VERSIONS.length;
export type MeasurementClasses = {
  producer: typeof MEASUREMENT_PRODUCERS[number];
  event_name: typeof MEASUREMENT_EVENTS[number];
  producer_version: typeof MEASUREMENT_SDK_VERSIONS[number];
};
export type BatchDiagnosticGroup = MeasurementClasses & { event_count: number };
type Header = { producer?: unknown; event_name?: unknown; producer_version?: unknown };

function closed<T extends string>(value: unknown, values: readonly T[]): T {
  return typeof value === "string" && values.includes(value as T) ? value as T : "other" as T;
}
export function measurementClasses(header: Header = {}, trustedProducer?: string): MeasurementClasses {
  const producer = closed(trustedProducer ?? header.producer, MEASUREMENT_PRODUCERS);
  return { producer, event_name: closed(header.event_name, MEASUREMENT_EVENTS),
    producer_version: producer === "other" ? "other" : closed(header.producer_version, MEASUREMENT_SDK_VERSIONS) };
}

/** Summarize already-submitted headers only. Neither payloads nor identifiers enter the result. */
export function batchDiagnosticGroups(producer: string, body: Buffer, eventCount: number): BatchDiagnosticGroup[] {
  let records: Header[];
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(parsed.records) || parsed.records.length !== eventCount) throw new Error("unavailable_headers");
    records = parsed.records.map((record: unknown) => record && typeof record === "object" ? record as Header : {});
  } catch {
    return [{ ...measurementClasses({}, producer), event_count: eventCount }];
  }
  const groups = new Map<string, BatchDiagnosticGroup>();
  for (const record of records) {
    const classes = measurementClasses(record, producer), key = JSON.stringify(classes);
    const previous = groups.get(key);
    if (previous) previous.event_count += 1;
    else groups.set(key, { ...classes, event_count: 1 });
  }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => group);
}
