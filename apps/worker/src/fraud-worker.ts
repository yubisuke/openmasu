import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import {
  evaluateSourceDayWithBundle,
  fraudBundleHash,
  fraudNumberParameter,
  sha256Jcs,
  type FraudBundle,
} from "@openmasu/fraud-rules";
import { uuidV7, withTenant } from "@openmasu/runtime";
import { resolveActiveFraudBundleWithClient } from "./fraud-bundle-runtime.js";

type SourceAggregate = {
  metric_date: string;
  campaign_id: string;
  network: string;
  site_id: string;
  clicks: string;
  installs: string;
  ctit_p05_ms: string | null;
  ctit_p50_ms: string | null;
  ctit_p95_ms: string | null;
  ctit_negative_count: string;
  median_cvr: string;
};

export async function loadFraudBundle(path = "config/fraud-bundles/conservative-v1.json"): Promise<FraudBundle> {
  const bundle = JSON.parse(await readFile(path, "utf8")) as FraudBundle;
  fraudBundleHash(bundle);
  return bundle;
}

function sourceRef(tenantId: string, appId: string, row: SourceAggregate): string {
  return `source:${tenantId}:${appId}:${row.metric_date}:${row.campaign_id}:${row.network}:${row.site_id}`;
}

async function persistAggregate(client: PoolClient, tenantId: string, appId: string, row: SourceAggregate, now: string): Promise<void> {
  const artifact = {
    metric_date: row.metric_date,
    campaign_id: row.campaign_id,
    network: row.network,
    site_id: row.site_id,
    clicks: Number(row.clicks),
    installs: Number(row.installs),
    ctit_p05_ms: row.ctit_p05_ms === null ? null : Number(row.ctit_p05_ms),
    ctit_p50_ms: row.ctit_p50_ms === null ? null : Number(row.ctit_p50_ms),
    ctit_p95_ms: row.ctit_p95_ms === null ? null : Number(row.ctit_p95_ms),
    ctit_negative_count: Number(row.ctit_negative_count),
  };
  const snapshot = sha256Jcs(artifact);
  await client.query(
    `INSERT INTO ledger.source_day_aggregates (
      tenant_id,app_id,metric_date,campaign_id,network,site_id,clicks,installs,
      ctit_p05_ms,ctit_p50_ms,ctit_p95_ms,ctit_negative_count,input_snapshot_id,computed_at,artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
    ON CONFLICT DO NOTHING`,
    [tenantId, appId, row.metric_date, row.campaign_id, row.network, row.site_id,
      row.clicks, row.installs, row.ctit_p05_ms, row.ctit_p50_ms, row.ctit_p95_ms,
      row.ctit_negative_count, snapshot, now,
      JSON.stringify(artifact)],
  );
}

async function persistSourceDecision(
  client: PoolClient,
  tenantId: string,
  appId: string,
  row: SourceAggregate,
  bundle: FraudBundle,
  now: string,
): Promise<void> {
  const hit = evaluateSourceDayWithBundle({
    clicks: Number(row.clicks),
    installs: Number(row.installs),
    medianCvr: Number(row.median_cvr),
    ...(row.ctit_p50_ms === null ? {} : { ctitP50Ms: Number(row.ctit_p50_ms) }),
    ...(row.ctit_p95_ms === null ? {} : { ctitP95Ms: Number(row.ctit_p95_ms) }),
  }, bundle);
  if (!hit) return;
  const subject = sourceRef(tenantId, appId, row);
  const evidenceDigest = sha256Jcs({ subject, row });
  const artifact = {
    fraud_decision_id: `fraud:${sha256Jcs({ subject, evidenceDigest, bundle: fraudBundleHash(bundle) })}`,
    subject_scope: "source",
    subject_ref: subject,
    decision: hit.decision,
    action: hit.action,
    reason_code: hit.reasonCode,
    reason_code_version: "0.4.0",
    evidence: [{ type: hit.evidenceType, captured_at: now, digest: evidenceDigest, access_class: "protected" }],
    rule_bundle_id: bundle.id,
    rule_bundle_version: bundle.version,
    rule_bundle_hash: fraudBundleHash(bundle),
    rule_id: hit.ruleId,
    evaluated_at: now,
  };
  await client.query(
    `INSERT INTO ledger.fraud_decisions (
      fraud_decision_id,tenant_id,app_id,subject_ref,subject_scope,rule_id,
      decision,action,reason_code,evaluated_at,artifact
    ) VALUES ($1,$2,$3,$4,'source',$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (fraud_decision_id) DO NOTHING`,
    [artifact.fraud_decision_id, tenantId, appId, subject, hit.ruleId, hit.decision,
      hit.action, hit.reasonCode, now, JSON.stringify(artifact)],
  );
}

async function markClockAnomalyAttributionsProvisional(
  client: PoolClient,
  tenantId: string,
  appId: string,
  metricDate: string,
  negativeCount: number,
  installCount: number,
  bundle: FraudBundle,
  now: string,
): Promise<number> {
  if (installCount === 0) return 0;
  const negativeRate = negativeCount / installCount;
  const threshold = fraudNumberParameter(bundle, "ctit_negative_rate_threshold", 0.05);
  if (negativeRate <= threshold) return 0;
  const current = await client.query<{ artifact: Record<string, unknown> }>(
    `SELECT attribution.artifact
       FROM ledger.attribution_results attribution
       JOIN ledger.install_facts install
         ON install.tenant_id=attribution.tenant_id AND install.app_id=attribution.app_id
        AND install.installation_id=attribution.subject_ref
       JOIN ledger.click_facts click
         ON click.tenant_id=install.tenant_id AND click.app_id=install.app_id AND click.click_id=install.click_id
      WHERE attribution.tenant_id=$1 AND attribution.app_id=$2
        AND attribution.reason_code='valid_install_referrer'
        AND timezone('UTC',control.canonical_timestamp_value(click.redirector_click_at))::date=$3::date
        AND NOT EXISTS (
          SELECT 1 FROM ledger.attribution_results successor
           WHERE successor.tenant_id=attribution.tenant_id AND successor.app_id=attribution.app_id
             AND successor.artifact->>'supersedes_attribution_id'=attribution.attribution_id
        )
      ORDER BY attribution.attribution_id`,
    [tenantId, appId, metricDate],
  );
  for (const source of current.rows) {
    const prior = source.artifact as Record<string, any>;
    const priorId = String(prior.attribution_id);
    const replacement: Record<string, any> = {
      ...prior,
      attribution_id: `attribution:ctit-provisional:${sha256Jcs([priorId, metricDate]).slice(0, 32)}`,
      decided_at: now,
      input_cutoff_at: now,
      finality: "provisional",
      supersedes_attribution_id: priorId,
    };
    await client.query(
      `INSERT INTO ledger.attribution_results (
        attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,
        decided_at,status,method,model,reason_code,artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT (attribution_id) DO NOTHING`,
      [replacement.attribution_id, tenantId, appId, replacement.subject_scope, replacement.subject_ref,
        replacement.effective_at, replacement.decided_at, replacement.status, replacement.method,
        replacement.model, replacement.reason_code, JSON.stringify(replacement)],
    );
  }
  return current.rowCount ?? 0;
}

export async function aggregateSourceDay(
  pool: Pool,
  tenantId: string,
  metricDate: string,
  now = new Date().toISOString(),
): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const apps = await client.query<{ app_id: string }>(
      "SELECT app_id::text FROM control.apps WHERE tenant_id=$1 ORDER BY app_id",
      [tenantId],
    );
    let written = 0;
    for (const { app_id: appId } of apps.rows) {
      const activeRevision = await resolveActiveFraudBundleWithClient(client, tenantId, appId);
      const result = await client.query<SourceAggregate>(
        `WITH source AS (
           SELECT $3::date::text AS metric_date,
             coalesce(click.campaign_id,'unattributed') AS campaign_id,
             coalesce(click.network,'unattributed') AS network,
             coalesce(click.site_id,'unattributed') AS site_id,
             count(DISTINCT click.logical_event_id)::text AS clicks,
             count(DISTINCT install.logical_event_id)::text AS installs,
             (percentile_cont(0.05) WITHIN GROUP (ORDER BY
               extract(epoch FROM (control.canonical_timestamp_value(install.install_begin_at_server)-control.canonical_timestamp_value(click.redirector_click_at)))*1000)
               FILTER (WHERE control.canonical_timestamp_value(install.install_begin_at_server) >= control.canonical_timestamp_value(click.redirector_click_at)))::bigint::text AS ctit_p05_ms,
             (percentile_cont(0.5) WITHIN GROUP (ORDER BY
               extract(epoch FROM (control.canonical_timestamp_value(install.install_begin_at_server)-control.canonical_timestamp_value(click.redirector_click_at)))*1000)
               FILTER (WHERE control.canonical_timestamp_value(install.install_begin_at_server) >= control.canonical_timestamp_value(click.redirector_click_at)))::bigint::text AS ctit_p50_ms,
             (percentile_cont(0.95) WITHIN GROUP (ORDER BY
               extract(epoch FROM (control.canonical_timestamp_value(install.install_begin_at_server)-control.canonical_timestamp_value(click.redirector_click_at)))*1000)
               FILTER (WHERE control.canonical_timestamp_value(install.install_begin_at_server) >= control.canonical_timestamp_value(click.redirector_click_at)))::bigint::text AS ctit_p95_ms
             ,count(DISTINCT install.logical_event_id) FILTER (
               WHERE control.canonical_timestamp_value(install.install_begin_at_server)
                 < control.canonical_timestamp_value(click.redirector_click_at)
             )::text AS ctit_negative_count
           FROM ledger.click_facts click
           LEFT JOIN ledger.install_facts install
             ON install.tenant_id=click.tenant_id AND install.app_id=click.app_id AND install.click_id=click.click_id
           WHERE click.tenant_id=$1 AND click.app_id=$2
             AND timezone('UTC',control.canonical_timestamp_value(click.redirector_click_at))::date=$3::date
           GROUP BY click.campaign_id,click.network,click.site_id
         )
         SELECT source.*,
           coalesce((SELECT percentile_cont(0.5) WITHIN GROUP
             (ORDER BY installs::numeric / nullif(clicks::numeric,0)) FROM source),0)::text AS median_cvr
         FROM source ORDER BY campaign_id,network,site_id`,
        [tenantId, appId, metricDate],
      );
      for (const row of result.rows) {
        await persistAggregate(client, tenantId, appId, row, now);
        if (activeRevision) {
          await persistSourceDecision(client, tenantId, appId, row, activeRevision.definition, now);
        }
        written += 1;
      }
      if (activeRevision) {
        await markClockAnomalyAttributionsProvisional(
          client,
          tenantId,
          appId,
          metricDate,
          result.rows.reduce((sum, row) => sum + Number(row.ctit_negative_count), 0),
          result.rows.reduce((sum, row) => sum + Number(row.installs), 0),
          activeRevision.definition,
          now,
        );
      }
    }
    return written;
  });
}

export async function resolveExpiredQuarantines(pool: Pool, tenantId: string, now = new Date()): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const due = await client.query<{ fraud_decision_id: string; tenant_id: string; app_id: string; artifact: Record<string, unknown> }>(
        `SELECT quarantine.fraud_decision_id,quarantine.tenant_id,quarantine.app_id,decision.artifact
         FROM ephemeral.fraud_quarantines quarantine
         JOIN ledger.fraud_decisions decision USING (fraud_decision_id,tenant_id,app_id)
         WHERE quarantine.tenant_id=$1 AND quarantine.resolve_after <= $2
         ORDER BY quarantine.resolve_after,quarantine.fraud_decision_id
         FOR UPDATE OF quarantine SKIP LOCKED`,
        [tenantId, now.toISOString()],
      );
    for (const row of due.rows) {
        const prior = row.artifact;
        const decisionId = `fraud:${uuidV7(now.getTime())}`;
        const artifact = {
          ...prior,
          fraud_decision_id: decisionId,
          decision: "clear",
          action: "allow",
          evaluated_at: now.toISOString(),
          supersedes_fraud_decision_id: row.fraud_decision_id,
        };
        delete (artifact as Record<string, unknown>).resolution_deadline_at;
        await client.query(
          `INSERT INTO ledger.fraud_decisions (
            fraud_decision_id,tenant_id,app_id,subject_ref,subject_scope,rule_id,
            decision,action,reason_code,evaluated_at,supersedes_fraud_decision_id,artifact
          ) VALUES ($1,$2,$3,$4,$5,$6,'clear','allow',$7,$8,$9,$10::jsonb)`,
          [decisionId, row.tenant_id, row.app_id, prior.subject_ref,
            prior.subject_scope ?? "record", prior.rule_id ?? null, prior.reason_code,
            now.toISOString(), row.fraud_decision_id, JSON.stringify(artifact)],
        );
        await client.query("DELETE FROM ephemeral.fraud_quarantines WHERE fraud_decision_id=$1", [row.fraud_decision_id]);
    }
    return due.rowCount ?? 0;
  });
}
