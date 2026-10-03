import { createHash } from "node:crypto";
import { jcs } from "@openmasu/attribution-core/canonical";
import { selectDisjointCosts } from "@openmasu/attribution-core";
import { compareMetricText } from "./model.js";
import type { CostSelection, CurrentCost, DisjointCost, MetricClient, MetricGrouping, MetricScope, SnapshotRecord, SnapshotScan } from "./model.js";

type SnapshotRecordRow = SnapshotRecord & { policy_digest?: string };

/** SQL rows stop here; calculation only receives the declared snapshot fields. */
export function snapshotRecordFromRow(row: SnapshotRecordRow): SnapshotRecord {
  return {
    tenant_id: row.tenant_id, app_id: row.app_id, record_id: row.record_id,
    received_at: row.received_at, lifecycle_status: row.lifecycle_status,
    privacy_request_id: row.privacy_request_id,
  };
}

export async function scanSnapshotRecords(
  client: MetricClient,
  scope: MetricScope,
  watermark: string,
  privacyState: "before" | "after",
): Promise<SnapshotScan> {
  const cursorName = "m1b_snapshot_records";
  await client.query(
    `DECLARE ${cursorName} NO SCROLL CURSOR FOR
     SELECT raw.tenant_id, raw.app_id, raw.record_id, raw.received_at, raw.policy_digest,
            CASE WHEN $4='before' THEN 'available'
                 ELSE state.lifecycle_status END AS lifecycle_status,
            CASE WHEN $4='before' THEN NULL
                 ELSE state.privacy_request_id END AS privacy_request_id
     FROM ledger.raw_records AS raw
     JOIN ledger.logical_events AS logical
       ON logical.record_id=raw.record_id
      AND logical.tenant_id=raw.tenant_id
      AND logical.app_id=raw.app_id
     JOIN LATERAL (
       SELECT payload.lifecycle_status, payload.privacy_request_id
       FROM ledger.raw_payload_states AS payload
       WHERE payload.record_id=raw.record_id
         AND payload.tenant_id=raw.tenant_id
         AND payload.app_id=raw.app_id
       ORDER BY payload.state_seq DESC
       LIMIT 1
     ) AS state ON true
     WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.received_at <= $3
     ORDER BY raw.received_at, raw.record_id`,
    [scope.tenant_id, scope.app_id, watermark, privacyState],
  );
  const records: SnapshotRecord[] = [];
  const hasher = createHash("sha256");
  let first = true;
  hasher.update("[");
  const append = (row: unknown): void => {
    if (!first) hasher.update(",");
    hasher.update(jcs(row));
    first = false;
  };
  try {
    while (true) {
      const page = await client.query<SnapshotRecordRow>(`FETCH FORWARD 1000 FROM ${cursorName}`);
      if (page.rows.length === 0) break;
      for (const record of page.rows) {
        const policyDigest = record.policy_digest;
        if (!policyDigest) throw new Error(`missing policy digest for ${record.record_id}`);
        append([record.received_at, record.record_id, record.lifecycle_status, policyDigest]);
        records.push(snapshotRecordFromRow(record));
      }
    }
  } finally {
    await client.query(`CLOSE ${cursorName}`).catch(() => undefined);
  }
  return {
    records,
    append,
    finish: (costRows) => {
      // Fork the record prefix so mixed historical and safe-cost definitions
      // receive their own exact cost snapshot without another ledger scan.
      const copy = hasher.copy();
      let separator = first ? "" : ",";
      for (const row of costRows) { copy.update(separator + jcs(row)); separator = ","; }
      copy.update("]");
      return copy.digest("hex");
    },
  };
}

export async function currentCosts(
  client: MetricClient,
  scope: MetricScope,
  watermark: string,
  grouping: MetricGrouping | undefined,
): Promise<CurrentCost[]> {
  if (grouping?.attribution_status !== undefined && grouping.attribution_status !== "non_organic") return [];
  const result = await client.query<CurrentCost>(
    `SELECT tenant_id, app_id, cost_record_id, as_of,
            report_snapshot_digest, cost_key_digest AS dimension_digest
     FROM (
       SELECT DISTINCT ON (cost_key_digest)
         tenant_id, app_id, cost_record_id, as_of,
         report_snapshot_digest, cost_key_digest
       FROM ledger.cost_records
       WHERE tenant_id=$1 AND app_id=$2 AND as_of <= $3 AND NOT (artifact ? 'creative_id')
         AND ($4::text IS NULL OR campaign_id=$4)
         AND ($5::text IS NULL OR network=$5)
         AND ($6::text IS NULL OR country=$6)
         AND ($7::date IS NULL OR cost_date=$7::date)
       ORDER BY cost_key_digest, as_of DESC, cost_record_id COLLATE "C" DESC
     ) AS current
     ORDER BY as_of, cost_record_id`,
    [
      scope.tenant_id,
      scope.app_id,
      watermark,
      grouping?.campaign_id ?? null,
      grouping?.network ?? null,
      grouping?.country ?? null,
      grouping?.cohort_date ?? null,
    ],
  );
  // Snapshot order follows the contract's UTF-16 text order, not database locale.
  return result.rows.sort((left, right) => compareMetricText(left.as_of, right.as_of)
    || compareMetricText(left.cost_record_id, right.cost_record_id));
}

export async function disjointCosts(client: MetricClient, scope: MetricScope, watermark: string, grouping: MetricGrouping | undefined, detail = false): Promise<CostSelection> {
  if (grouping?.attribution_status !== undefined && grouping.attribution_status !== "non_organic") return { rows: [], overlapping: false };
  const result = await client.query<DisjointCost>(
    `SELECT DISTINCT ON (network, cost_date, campaign_id, ad_group_id, country, (artifact->>'creative_id'))
       tenant_id, app_id, cost_record_id, as_of, report_snapshot_digest, cost_key_digest AS dimension_digest,
       network, cost_date::text AS date, campaign_id, ad_group_id, artifact->>'creative_id' AS creative_id, country, currency, spend_unscaled, spend_scale
     FROM ledger.cost_records
     WHERE tenant_id=$1 AND app_id=$2 AND as_of <= $3
       AND ($4::text IS NULL OR campaign_id=$4) AND ($5::text IS NULL OR network=$5)
       AND ($6::text IS NULL OR country=$6) AND ($7::date IS NULL OR cost_date=$7::date)
       AND ($8::boolean OR NOT (artifact ? 'creative_id'))
       AND ($9::text IS NULL OR ad_group_id=$9) AND ($10::text IS NULL OR artifact->>'creative_id'=$10)
     ORDER BY network, cost_date, campaign_id, ad_group_id, country, (artifact->>'creative_id'), as_of DESC, cost_record_id COLLATE "C" DESC`,
    [scope.tenant_id, scope.app_id, watermark, grouping?.campaign_id ?? null, grouping?.network ?? null,
      grouping?.country ?? null, grouping?.cohort_date ?? null, detail, grouping?.ad_group_id ?? null, grouping?.creative_id ?? null],
  );
  return selectDisjointCosts(result.rows, detail);
}
