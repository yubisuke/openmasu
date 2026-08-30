import {
  createAppPool,
  EncryptedFilePayloadStore,
  EnvironmentSecretStore,
  processPrivacyDeletionJobs,
  withTenant,
} from "@openmasu/runtime";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tenantId = option("--tenant");
if (!tenantId || !/^[A-Za-z0-9._:-]{1,128}$/.test(tenantId)) {
  throw new Error("db:drain-privacy-purge requires --tenant <tenant-id>");
}
const maximumCycles = Number(option("--maximum-cycles") ?? "100");
if (!Number.isSafeInteger(maximumCycles) || maximumCycles < 1 || maximumCycles > 10_000) {
  throw new Error("--maximum-cycles must be an integer from 1 through 10000");
}
const secrets = new EnvironmentSecretStore({
  OPENMASU_PAYLOAD_MASTER_KEY: {
    value: process.env.OPENMASU_PAYLOAD_MASTER_KEY,
    file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE,
  },
});
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(
  process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads",
  secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"),
);
let cycles = 0;
let jobs = 0;
let completed = 0;
let payloadsPurged = 0;
let stalled = false;
try {
  while (cycles < maximumCycles) {
    cycles += 1;
    const result = await processPrivacyDeletionJobs({ pool, payloadStore, tenantId });
    jobs += result.jobs;
    completed += result.completed;
    payloadsPurged += result.payloadsPurged;
    if (result.jobs === 0) break;
    if (result.processing > 0 && result.payloadsPurged === 0) {
      stalled = true;
      break;
    }
  }
  const remaining = await withTenant(pool, tenantId, async (client) => Number((await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control.privacy_deletion_jobs WHERE tenant_id=$1 AND status='processing'",
    [tenantId],
  )).rows[0]?.count ?? "0"));
  const drained = remaining === 0;
  process.stdout.write(`${JSON.stringify({
    tenant_id: tenantId,
    cycles,
    jobs,
    completed,
    payloads_purged: payloadsPurged,
    drained,
    stalled,
  })}\n`);
  if (!drained || stalled) process.exitCode = 2;
} finally {
  await pool.end();
}
