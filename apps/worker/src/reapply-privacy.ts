import {
  createAppPool,
  EncryptedFilePayloadStore,
  EnvironmentSecretStore,
} from "@open-mmp/runtime";
import { reapplyCompletedPrivacyRequests } from "./privacy-reapply.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tenantId = option("--tenant");
if (!tenantId || !/^[A-Za-z0-9._:-]{1,128}$/.test(tenantId)) {
  throw new Error("db:reapply-privacy requires --tenant <tenant-id>");
}
const secrets = new EnvironmentSecretStore({
  OPENMMP_PAYLOAD_MASTER_KEY: {
    value: process.env.OPENMMP_PAYLOAD_MASTER_KEY,
    file: process.env.OPENMMP_PAYLOAD_MASTER_KEY_FILE,
  },
});
const pool = createAppPool();
try {
  const result = await reapplyCompletedPrivacyRequests({
    pool,
    payloadStore: new EncryptedFilePayloadStore(
      process.env.OPENMMP_PAYLOAD_STORE_DIR ?? ".openmmp/payloads",
      secrets.require("OPENMMP_PAYLOAD_MASTER_KEY"),
    ),
    tenantId,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.unsupported_metric_runs > 0) process.exitCode = 2;
} finally {
  await pool.end();
}
