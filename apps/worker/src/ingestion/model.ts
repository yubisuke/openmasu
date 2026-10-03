

export type Any = Record<string, any>;

export type RuntimeIngestionResult = {
  raw_records: Any[];
  deliveries: Any[];
  logical_events: Any[];
  corrections: Any[];
  rejections: Any[];
  attributions: Any[];
  fraud_decisions: Any[];
  reconciliation: Any[];
  validation_failures: Array<{ record_id: string; delivery_id: string; fields: readonly string[] }>;
};
