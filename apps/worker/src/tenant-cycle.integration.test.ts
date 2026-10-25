import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";
import { jcs } from "@openmasu/attribution-core/canonical";
import { createAppPool, createMigrationPool, createReaderPool, createSeedPool, EncryptedFilePayloadStore, uuidV7, withTenant } from "@openmasu/runtime";
import { registerOperatorBulkExportDestination } from "../../api/src/operator-bulk-exports-admin.js";
import { discoverOperatorBulkExports } from "./operator-bulk-export-worker.js";
import type { CostInput } from "./import/cost.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { ingestFixture } from "./test-support/fixture-ingestion.js";

type Message = { id?: string; stage: string; error?: string; result?: any };
class WorkerProbe {
  readonly child: ChildProcess;
  private messages: Message[] = [];
  private notify = new Set<() => void>();
  constructor() {
    this.child = fork(new URL("../../../tools/test-support/tenant-cycle-process.ts", import.meta.url), [],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
    // Drain output but never copy environment, credentials or provider bodies to CI logs.
    this.child.stdout!.resume(); this.child.stderr!.resume();
    this.child.on("message", (value: Message) => { this.messages.push(value); for (const notify of this.notify) notify(); });
    this.child.on("exit", () => { for (const notify of this.notify) notify(); });
  }
  async wait(stage: string, id?: string): Promise<Message> {
    const find = () => this.messages.find(message => message.stage === stage && message.id === id);
    if (find()) return find()!;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.notify.delete(check); reject(new Error(`synthetic_worker_${stage}_timeout`)); }, 15_000);
      const check = () => {
        const message = find();
        if (!message && this.child.exitCode === null && this.child.signalCode === null) return;
        clearTimeout(timeout); this.notify.delete(check);
        if (message) resolve(message); else reject(new Error("synthetic_worker_exited_before_result"));
      };
      this.notify.add(check); check();
    });
  }
  start(command: Record<string, unknown>): string {
    const id = uuidV7(); this.child.send({ ...command, id }); return id;
  }
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit"); this.child.kill(signal); await exited;
  }
}

const pool = createAppPool(), seed = createSeedPool(), owner = createMigrationPool(), reader = createReaderPool();
const root = mkdtempSync(join(tmpdir(), "openmasu-cycle-"));
const payloads = new EncryptedFilePayloadStore(root, "synthetic-cycle-master-key-0000000000000000");
const held = new Map<string, ServerResponse>();
const objects: Buffer[] = [];
const server = createServer(async (request, response) => {
  if (request.url!.startsWith("/wait/")) { held.set(request.url!, response); return; }
  if (request.url === "/resume") { response.end("synthetic-provider-complete"); return; }
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  objects.push(Buffer.concat(chunks)); response.end();
});
let origin: string;
const workers: WorkerProbe[] = [];
async function worker() { const probe = new WorkerProbe(); workers.push(probe); await probe.wait("ready"); return probe; }
async function gateReady(path: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!held.has(path)) { if (Date.now() > until) throw new Error("synthetic_provider_timeout"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function release(path: string) { held.get(path)?.end("synthetic-provider-complete"); held.delete(path); }
async function setup() {
  const tenantId = `tenant-cycle-${uuidV7().slice(-12)}`, appId = "app-a";
  const input = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8").replaceAll("tenant-a", tenantId));
  input.metric_evaluations = [{ ...input.metric_evaluations[0], metric_names: ["d7_roas"], metric_run_id_prefix: "run-cycle" }];
  // The cost job supplies the only denominator. Original fixture dimension
  // digests belong to its original tenant and are not a second imported report.
  input.cost_records = [];
  await ingestFixture(`cycle-${tenantId}`, { ...input, metric_evaluations: [] }, pool, seed);
  return { tenantId, appId, input };
}
async function state(tenant: string) {
  return withTenant(pool, tenant, async client => (await client.query(
    "SELECT generation::text,owner_pid,status,interrupted_cycles::text FROM control.worker_tenant_cycles WHERE tenant_id=$1", [tenant])).rows[0]);
}
async function appExists(tenant: string, app: string) {
  return withTenant(pool, tenant, async client => (await client.query(
    "SELECT count(*)::int AS count FROM control.apps WHERE tenant_id=$1 AND app_id=$2", [tenant, app])).rows[0].count);
}
describe("cross-process tenant cycle coordination", { concurrency: false, timeout: 90_000 }, () => {
  before(async () => { server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  after(async () => {
    for (const response of held.values()) response.end();
    await Promise.all(workers.map(worker => worker.stop("SIGKILL")));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.all([pool.end(), seed.end(), owner.end(), reader.end()]); rmSync(root, { recursive: true, force: true });
  });
  it("two_workers_keep_cost_before_metric_and_let_another_tenant_pass_a_stalled_provider_without_double_publication", async () => {
    const test = await setup(), first = await worker(), second = await worker();
    const cost: CostInput = { tenant_id: test.tenantId, app_id: test.appId, network: "synthetic-network", campaign_id: "provider-campaign-33",
      country: "JP", date: "2026-08-01", amount_unscaled: "200000000", amount_scale: 6, currency: "USD", source: "imported_reported", as_of: "2026-08-08T12:00:00.000Z" };
    const path = "/wait/cost";
    const id = first.start({ ...test, mode: "publish", cost, providerUrl: origin + path });
    await first.wait("waiting", id); await gateReady(path);
    const busy = second.start({ ...test, mode: "publish", cost });
    assert.equal((await second.wait("done", busy)).result.status, "busy");
    const independent = second.start({ tenantId: test.tenantId + "-other", appId: "app-progress", mode: "touch" });
    assert.equal((await second.wait("done", independent)).result.status, "completed");
    assert.equal(await appExists(test.tenantId + "-other", "app-progress"), 1);
    release(path);
    const result = await first.wait("done", id); assert.equal(result.error, undefined); assert.equal(result.result.value.outcome, "succeeded");
    const runs = result.result.value.runs; assert.equal(runs[0].value_unscaled, "750000");
    const expected = await computeSqlMetricRuns(pool, test.input, false);
    assert.equal(jcs(runs), jcs(expected), "fenced worker preserves the unfenced single-worker SQL bytes on the same ledger snapshot");
    const repeat = second.start({ ...test, mode: "publish", cost });
    assert.equal((await second.wait("done", repeat)).result.value.outcome, "not_due");
    const count = await withTenant(pool, test.tenantId, c => c.query("SELECT count(*)::int AS count FROM ledger.metric_runs WHERE tenant_id=$1", [test.tenantId]));
    assert.equal(count.rows[0].count, 1);
    await assert.rejects(withTenant(reader, test.tenantId, c => c.query("SELECT * FROM control.worker_tenant_cycles")), /permission denied/);
  });
  it("expired_job_lease_cannot_steal_a_live_cycle_and_SIGTERM_or_forced_death_resume_durable_claims", async () => {
    const tenantId = `tenant-cycle-kill-${uuidV7().slice(-12)}`, second = await worker();
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      await withTenant(pool, tenantId, c => c.query(
        "UPDATE control.worker_job_schedules SET next_run_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [tenantId]));
      const first = await worker(), path = `/wait/${signal}`, appId = `app-${signal}`;
      const id = first.start({ tenantId, appId, mode: "hold", providerUrl: origin + path });
      await first.wait("waiting", id); await gateReady(path);
      await withTenant(pool, tenantId, client => client.query(
        "UPDATE control.worker_job_schedules SET lease_expires_at=clock_timestamp()-interval '1 second',next_run_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [tenantId]));
      const busy = second.start({ tenantId, appId: "app-not-entered", mode: "touch" });
      assert.equal((await second.wait("done", busy)).result.status, "busy");
      await first.stop(signal); release(path);
      assert.equal(await appExists(tenantId, appId), 0, "in-flight transaction rolled back on process death");
      const resumed = second.start({ tenantId, appId, mode: "hold", providerUrl: origin + "/resume" });
      const output = await second.wait("done", resumed);
      assert.equal(output.error, undefined); assert.equal(output.result.value.outcome, "succeeded");
      assert.equal(await appExists(tenantId, appId), 1);
    }
    assert.equal((await state(tenantId)).interrupted_cycles, "2");
  });
  it("lost_owner_backend_fences_other_connections_and_privacy_precedes_export_across_processes", async () => {
    const test = await setup(), first = await worker(), second = await worker(), path = "/wait/stale-owner";
    const id = first.start({ tenantId: test.tenantId, appId: "app-stale-publication", mode: "hold", providerUrl: origin + path });
    await first.wait("waiting", id); await gateReady(path);
    const current = await state(test.tenantId);
    await owner.query("SELECT pg_terminate_backend($1)", [current.owner_pid]);
    const replacement = second.start({ tenantId: test.tenantId, appId: "app-live-publication", mode: "touch" });
    assert.equal((await second.wait("done", replacement)).result.status, "completed");
    release(path);
    const stale = await first.wait("done", id); assert.equal(stale.error, "worker_tenant_cycle_lost");
    assert.equal(await appExists(test.tenantId, "app-stale-publication"), 0);
    assert.equal(await appExists(test.tenantId, "app-live-publication"), 1);
    assert.equal((await state(test.tenantId)).interrupted_cycles, "1");
    await registerOperatorBulkExportDestination({ pool, payloadStore: payloads,
      identity: { tenantId: test.tenantId, appId: test.appId, keyId: "synthetic-cycle-admin", role: "admin" },
      body: { endpoint_url: origin, bucket_name: "synthetic-cycle-bucket", object_prefix: "synthetic/cycle", region: "auto",
        events: ["ad_revenue"], start_at: "2020-01-01T00:00:00.000Z", access_key_id: "SYNTHETICCYCLEKEY", secret_access_key: "synthetic/secret/access/key/0001" },
      destinationAllowlist: [origin], allowSyntheticLoopback: true });
    assert.equal(await discoverOperatorBulkExports(pool, payloads, test.tenantId), 1);
    const privacyPath = "/wait/privacy";
    const privacy = first.start({ ...test, mode: "privacy_export", payloadRoot: root, storageOrigin: origin, providerUrl: origin + privacyPath });
    await first.wait("waiting", privacy); await gateReady(privacyPath);
    const overlapping = second.start({ ...test, mode: "privacy_export", payloadRoot: root, storageOrigin: origin });
    assert.equal((await second.wait("done", overlapping)).result.status, "busy");
    release(privacyPath);
    const done = await first.wait("done", privacy); assert.equal(done.error, undefined); assert.equal(done.result.status, "completed");
    assert.equal(objects.length, 1, "only the post-privacy deletion object is sent");
    const lines = gunzipSync(objects[0]).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(lines.some(line => line.record_kind === "privacy_deletion"));
    assert.equal(lines.some(line => line.event_name === "ad_revenue"), false);
    const counts = await withTenant(pool, test.tenantId, c => c.query(
      "SELECT (SELECT count(*)::int FROM ledger.privacy_requests WHERE tenant_id=$1) AS requests,(SELECT count(*)::int FROM ledger.operator_bulk_export_results WHERE tenant_id=$1) AS exports", [test.tenantId]));
    assert.deepEqual(counts.rows[0], { requests: 1, exports: 1 });
  });
});
