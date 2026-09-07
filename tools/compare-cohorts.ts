import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "@openmasu/attribution-core";
import { renderComparison } from "./cohort-comparison-html.js";

const fields = ["date_from", "date_to", "time_zone", "maturity", "aggregation", "attribution_scope", "metric_definition", "source_cutoff"] as const;
type Conditions = Record<typeof fields[number], string>;
type Row = { key: string; currency: string; scale: number } & ({ state: "present"; value: string } | { state: "undefined"; reason: string });
type Provenance = { report_sha256: string; runs: { key: string; metric_run_id: string; input_snapshot_id: string }[] };
type Snapshot = { source: string; conditions: Conditions; rows: Row[]; provenance?: Provenance };
function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("expected_object");
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).length !== allowed.length || Object.keys(v).some(k => !allowed.includes(k))) throw Error("invalid_fields");
}
function text(v: unknown): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > 256 || /[\u0000-\u001f]/.test(v)) throw Error("invalid_text");
}
function date(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw Error("invalid_date");
}
export function parseSnapshot(input: unknown): Snapshot {
  object(input); keys(input, ["source", "conditions", "rows", ...("provenance" in input ? ["provenance"] : [])]); text(input.source);
  object(input.conditions); keys(input.conditions, fields);
  for (const key of fields) text(input.conditions[key]);
  const c = input.conditions as Conditions;
  date(c.date_from); date(c.date_to);
  if (c.date_from >= c.date_to) throw Error("invalid_range");
  new Intl.DateTimeFormat("en", { timeZone: c.time_zone });
  if (!["cumulative", "on_day"].includes(c.aggregation)) throw Error("invalid_aggregation");
  if (!Number.isFinite(Date.parse(c.source_cutoff)) || new Date(c.source_cutoff).toISOString() !== c.source_cutoff) throw Error("invalid_cutoff");
  if (!Array.isArray(input.rows) || input.rows.length > 10000) throw Error("invalid_rows");
  const seen = new Set<string>();
  for (const r of input.rows) {
    object(r); keys(r, ["key", "currency", "scale", "state", r.state === "present" ? "value" : "reason"]);
    text(r.key); text(r.currency);
    if (!/^(?:[A-Z]{3}|none)$/.test(r.currency)) throw Error("invalid_currency");
    if (seen.has(r.key)) throw Error("duplicate_key"); seen.add(r.key);
    if (!Number.isInteger(r.scale) || Number(r.scale) < 0 || Number(r.scale) > 18) throw Error("invalid_scale");
    if (r.state === "present") {
      if (typeof r.value !== "string" || !/^(?:0|-?[1-9]\d{0,99})$/.test(r.value)) throw Error("invalid_integer");
    } else if (r.state === "undefined") text(r.reason);
    else throw Error("invalid_state");
  }
  let provenance: Provenance | undefined;
  if ("provenance" in input) {
    const p = input.provenance; object(p); keys(p, ["report_sha256", "runs"]);
    if (typeof p.report_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.report_sha256) || !Array.isArray(p.runs) || p.runs.length !== input.rows.length) throw Error("invalid_provenance");
    const refs = new Set<string>(), ids = new Set<string>();
    for (const r of p.runs) {
      object(r); keys(r, ["key", "metric_run_id", "input_snapshot_id"]);
      text(r.key); text(r.metric_run_id);
      if (!seen.has(r.key) || refs.has(r.key) || ids.has(r.metric_run_id) || typeof r.input_snapshot_id !== "string" || !/^[a-f0-9]{64}$/.test(r.input_snapshot_id)) throw Error("invalid_provenance");
      refs.add(r.key); ids.add(r.metric_run_id);
    }
    provenance = { report_sha256: p.report_sha256, runs: [...p.runs].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) } as Provenance;
  }
  return { source: input.source, conditions: { ...c }, rows: [...input.rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), ...(provenance ? { provenance } : {}) } as Snapshot;
}
export function compareSnapshots(left: unknown, right: unknown) {
  const a = parseSnapshot(left), b = parseSnapshot(right);
  const digest = (v: Snapshot) => createHash("sha256").update(jcs(v)).digest("hex");
  const mismatches = fields.filter(k => a.conditions[k] !== b.conditions[k]);
  const provenance = { left: { source: a.source, sha256: digest(a) }, right: { source: b.source, sha256: digest(b) } };
  if (mismatches.length) return { format: "cohort-comparison-v1", provenance, status: "incomparable", mismatches, rows: [] };
  const am = new Map(a.rows.map(r => [r.key, r])), bm = new Map(b.rows.map(r => [r.key, r]));
  const rows = [...new Set([...am.keys(), ...bm.keys()])].sort().map(key => {
    const l = am.get(key), r = bm.get(key);
    if (!l || !r) return { key, status: !l ? "missing_left" : "missing_right", left: l ?? null, right: r ?? null };
    if (l.currency !== r.currency) return { key, status: "currency_mismatch", left: l, right: r };
    if (l.state !== "present" || r.state !== "present") return { key, status: "undefined", left: l, right: r };
    const scale = Math.max(l.scale, r.scale);
    const delta = BigInt(r.value) * 10n ** BigInt(scale - r.scale) - BigInt(l.value) * 10n ** BigInt(scale - l.scale);
    return { key, status: delta === 0n ? "equal" : "different", currency: l.currency, scale, delta_right_minus_left: delta.toString(), left: l, right: r };
  });
  return { format: "cohort-comparison-v1", provenance, conditions: a.conditions, status: "compared", rows };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const html = process.argv[2] === "--html";
    const args = process.argv.slice(html ? 3 : 2);
    if (args.length !== 2) throw Error("usage: compare:cohorts -- left.json right.json");
    const inputs = args.map(path => {
      if (statSync(path).size > 4 * 1024 * 1024) throw Error("input_too_large");
      return JSON.parse(readFileSync(path, "utf8"));
    });
    const comparison = compareSnapshots(inputs[0], inputs[1]);
    process.stdout.write(html ? renderComparison(comparison) : `${jcs(comparison)}\n`);
  } catch { console.error("Comparison failed: check arguments and snapshot format; inputs were not printed."); process.exitCode = 1; }
}
