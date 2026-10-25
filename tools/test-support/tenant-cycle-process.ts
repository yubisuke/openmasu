// Synthetic child-process probe of the same cycle/scheduler used by main.ts.
import { Pool } from "pg";
import { createAppPool, EncryptedFilePayloadStore, PostgresSchedulerStore, runScheduledJob, runTenantCycle, withTenant } from "@openmasu/runtime";
import { persistCostImport, type CostInput } from "../../apps/worker/src/import/cost.js";
import { computeSqlMetricRuns } from "../../apps/worker/src/metrics/cohort.js";
import { executePrivacyRequest, privacySubjectDigest } from "../../apps/api/src/privacy.js";
import { discoverOperatorBulkExports, processOperatorBulkExports } from "../../apps/worker/src/operator-bulk-export-worker.js";
import { TenantWorkCoordinator, waitForWorkerDrain } from "../../apps/worker/src/tenant-work-coordinator.js";

const pool = createAppPool();
const scheduler = new Pool({ connectionString: process.env.OPENMASU_APP_DATABASE_URL, max: 1 });
const coordination = new Pool({ connectionString: process.env.OPENMASU_APP_DATABASE_URL, max: 1 });
const coordinator = new TenantWorkCoordinator({ concurrency: 1, onFailure: () => undefined });
const policy = { intervalMs: 60_000, retryMs: 1_000, leaseMs: 30_000 };
const send = (value: unknown) => process.send?.(value);
type Command = {
  id: string; tenantId: string; appId: string; mode: "publish" | "hold" | "touch" | "privacy_export";
  providerUrl?: string; cost?: CostInput; input?: unknown; payloadRoot?: string; storageOrigin?: string;
};
async function cycle(command: Command): Promise<void> {
  try {
    const result = await runTenantCycle({ coordinationPool: coordination, pools: [pool, scheduler], tenantId: command.tenantId,
      task: async ({ pools }) => {
        const [jobs, schedules] = pools;
        const store = new PostgresSchedulerStore(schedules);
        if (command.mode === "privacy_export") {
          const payloads = new EncryptedFilePayloadStore(command.payloadRoot!, "synthetic-cycle-master-key-0000000000000000");
          const body = { tenant_id: command.tenantId, app_id: command.appId, requested_via: "tenant_admin_api" as const,
            deletion_scope: "app" as const, deletion_subject_ref: command.appId };
          const privacy = await runScheduledJob({ store, tenantId: command.tenantId, job: "privacy_purge", policy, task: async () => {
            if (command.providerUrl) { send({ id: command.id, stage: "waiting" }); await fetch(command.providerUrl); }
            await executePrivacyRequest(jobs, { tenantId: command.tenantId, appId: command.appId, keyId: "synthetic-cycle-admin", role: "admin",
              deletionSubjectDigest: privacySubjectDigest("synthetic-cycle-privacy-key", body) }, body, payloads,
            new Date("2026-10-25T00:00:00.000Z"));
          } });
          if (privacy !== "succeeded") throw new Error("synthetic_privacy_not_completed");
          const discovered = await discoverOperatorBulkExports(jobs, payloads, command.tenantId);
          const exported = await processOperatorBulkExports(jobs, payloads, command.tenantId, { enabled: true,
            destinationAllowlist: [command.storageOrigin!], allowSyntheticLoopback: true });
          return { discovered, exported };
        }
        if (command.mode === "touch") {
          await withTenant(jobs, command.tenantId, client => client.query(
            "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
            [command.tenantId, command.appId, "2026-10-25T00:00:00.000Z"]));
          return { touched: true };
        }
        const outcome = await runScheduledJob({ store, tenantId: command.tenantId, job: "cost_refresh", policy, task: async () => {
          if (command.mode === "hold") {
            // Keep an uncommitted write on a DIFFERENT backend from the cycle
            // owner. Losing only the owner must roll this write back too.
            await withTenant(jobs, command.tenantId, async client => {
              await client.query("INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)",
                [command.tenantId, command.appId, "2026-10-25T00:00:00.000Z"]);
              send({ id: command.id, stage: "waiting" });
              await fetch(command.providerUrl!);
            });
          } else {
            if (command.providerUrl) { send({ id: command.id, stage: "waiting" }); await fetch(command.providerUrl); }
            await persistCostImport(jobs, "synthetic-cycle-cost", [command.cost!]);
          }
        } });
        const runs = command.mode === "publish" && outcome === "succeeded"
          ? await computeSqlMetricRuns(jobs, command.input) : [];
        return { outcome, runs };
      } });
    send({ id: command.id, stage: "done", result });
  } catch (error) {
    send({ id: command.id, stage: "done", error: error instanceof Error ? error.message : "synthetic_probe_failed" });
  }
}
process.on("message", (message: Command) => {
  if (!coordinator.submit(message.tenantId, () => cycle(message))) send({ id: message.id, stage: "done", error: "local_cycle_busy" });
});
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  coordinator.close();
  void waitForWorkerDrain(coordinator, undefined, AbortSignal.timeout(1_000)).then(async drained => {
    if (!drained) process.exit(1);
    await Promise.all([pool.end(), scheduler.end(), coordination.end()]);
    process.exit(0);
  });
});
send({ stage: "ready" });
