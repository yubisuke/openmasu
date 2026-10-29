import type { PoolClient } from "pg";

export type InboxAdmissionPolicy = {
  appCount: number;
  appBytes: number;
  globalCount: number;
  globalBytes: number;
  resumePercent: number;
  retryAfterSeconds: number;
};

export class InboxCapacityError extends Error {
  readonly status: 429 | 503;
  constructor(readonly reason: "inbox_app_capacity" | "inbox_global_capacity" | "inbox_capacity_unknown", readonly retryAfterSeconds: number) {
    super(reason);
    this.name = "InboxCapacityError";
    this.status = reason === "inbox_app_capacity" ? 429 : 503;
  }
}

export function validateInboxAdmissionPolicy(policy: InboxAdmissionPolicy): InboxAdmissionPolicy {
  if (Object.values(policy).some((value) => !Number.isSafeInteger(value) || value < 1)
    || policy.resumePercent > 99 || policy.retryAfterSeconds > 3600) {
    throw new Error("inbox_admission_configuration_invalid");
  }
  return policy;
}

/** One policy must be deployed consistently to every durable-inbox producer. */
export function readInboxAdmissionPolicy(): InboxAdmissionPolicy | undefined {
  const enabled = process.env.OPENMASU_INBOX_ADMISSION_ENABLED ?? "off";
  if (enabled === "off") return undefined;
  if (enabled !== "on") throw new Error("inbox_admission_configuration_invalid");
  return validateInboxAdmissionPolicy({
    appCount: Number(process.env.OPENMASU_INBOX_APP_MAX_BATCHES ?? "10000"),
    appBytes: Number(process.env.OPENMASU_INBOX_APP_MAX_BYTES ?? "268435456"),
    globalCount: Number(process.env.OPENMASU_INBOX_GLOBAL_MAX_BATCHES ?? "100000"),
    globalBytes: Number(process.env.OPENMASU_INBOX_GLOBAL_MAX_BYTES ?? "2147483648"),
    resumePercent: Number(process.env.OPENMASU_INBOX_RESUME_PERCENT ?? "80"),
    retryAfterSeconds: Number(process.env.OPENMASU_INBOX_RETRY_AFTER_SECONDS ?? "30"),
  });
}

/** Returns a refusal instead of throwing, so the hysteresis latch can commit. */
export async function admitInboxBatch(client: PoolClient, tenantId: string, appId: string, bodyBytes: number,
  policy: InboxAdmissionPolicy): Promise<InboxCapacityError | undefined> {
  validateInboxAdmissionPolicy(policy);
  const result = await client.query<{ decision: string }>(
    "SELECT control.admit_inbox_batch($1,$2,$3,$4,$5,$6,$7,$8) AS decision",
    [tenantId, appId, bodyBytes, policy.appCount, policy.appBytes, policy.globalCount, policy.globalBytes, policy.resumePercent],
  );
  const decision = result.rows[0]?.decision;
  if (decision === "accepted") return undefined;
  if (decision === "inbox_app_capacity" || decision === "inbox_global_capacity" || decision === "inbox_capacity_unknown") {
    return new InboxCapacityError(decision, policy.retryAfterSeconds);
  }
  throw new Error("inbox_admission_decision_invalid");
}
