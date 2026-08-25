import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import {
  JOB_HEALTH_ACTOR_REFS,
  JOB_HEALTH_JOBS,
  JOB_HEALTH_OUTCOMES,
  recordJobOutcome,
  runWithTerminalJobOutcome,
  type JobHealthJob,
  type JobHealthOutcome,
} from "./job-health.js";

describe("durable operator job health", () => {
  it("keeps the job, actor, and outcome vocabularies closed", async () => {
    assert.deepEqual(JOB_HEALTH_JOBS, [
      "mmp_import", "cost_import", "max_revenue_import", "google_conversion_delivery", "metric_run",
    ]);
    assert.deepEqual(JOB_HEALTH_OUTCOMES, ["succeeded", "failed"]);
    assert.deepEqual(JOB_HEALTH_ACTOR_REFS, {
      mmp_import: "job:mmp_import",
      cost_import: "job:cost_import",
      max_revenue_import: "job:max_revenue_import",
      google_conversion_delivery: "job:google_conversion_delivery",
      metric_run: "job:metric_run",
    });
    await assert.rejects(recordJobOutcome({
      pool: {} as Pool,
      tenantId: "tenant",
      appId: "app",
      job: "unknown" as JobHealthJob,
      outcome: "succeeded",
    }), /job health job is invalid/);
    await assert.rejects(recordJobOutcome({
      pool: {} as Pool,
      tenantId: "tenant",
      appId: "app",
      job: "mmp_import",
      outcome: "unknown" as JobHealthOutcome,
    }), /job health outcome is invalid/);
  });

  it("records one success after a successful task", async () => {
    const outcomes: JobHealthOutcome[] = [];
    const result = await runWithTerminalJobOutcome(
      async () => ({ value: 7 }),
      async (outcome) => { outcomes.push(outcome); },
    );
    assert.deepEqual(result, { value: 7 });
    assert.deepEqual(outcomes, ["succeeded"]);
  });

  it("records one failure and preserves the exact task error", async () => {
    const taskError = { kind: "task-error" };
    const outcomes: JobHealthOutcome[] = [];
    await assert.rejects(
      runWithTerminalJobOutcome(
        async () => { throw taskError; },
        async (outcome) => { outcomes.push(outcome); },
      ),
      (error) => error === taskError,
    );
    assert.deepEqual(outcomes, ["failed"]);
  });

  it("does not replace a task error when failure recording also fails", async () => {
    const taskError = { kind: "task-error" };
    await assert.rejects(
      runWithTerminalJobOutcome(
        async () => { throw taskError; },
        async () => { throw new Error("audit unavailable"); },
      ),
      (error) => error === taskError,
    );
  });

  it("fails a successful command on audit failure without writing a failure row", async () => {
    const auditError = { kind: "audit-error" };
    const outcomes: JobHealthOutcome[] = [];
    await assert.rejects(
      runWithTerminalJobOutcome(
        async () => "done",
        async (outcome) => {
          outcomes.push(outcome);
          throw auditError;
        },
      ),
      (error) => error === auditError,
    );
    assert.deepEqual(outcomes, ["succeeded"]);
  });
});
