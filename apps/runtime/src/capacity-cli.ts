import { Pool } from "pg";
import { databaseCapacity, payloadCapacity } from "./capacity.js";

try {
  if (process.argv.length !== 2) throw new Error("arguments_invalid");
  const connectionString = process.env.OPENMASU_MIGRATION_DATABASE_URL;
  const root = process.env.OPENMASU_PAYLOAD_STORE_DIR;
  if (!connectionString || !root) throw new Error("operator_configuration_required");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const client = await pool.connect();
    try {
      const observations = [await databaseCapacity(client), await payloadCapacity(root)];
      const incomplete = observations.some((observation) => observation.layers.some((layer) => layer.bytes.state === "unavailable" || layer.count.state === "unavailable"));
      console.log(JSON.stringify({ format: "openmasu-capacity-v1", status: incomplete ? "incomplete" : "observed", observations, growth_estimate: "not_calculated", production_capacity_verified: false }));
      if (incomplete) process.exitCode = 2;
    } finally { client.release(); }
  } finally { await pool.end(); }
} catch (error) {
  const reason = error instanceof Error && /^(arguments_invalid|operator_configuration_required)$/.test(error.message) ? error.message : "capacity_observation_failed";
  console.error(JSON.stringify({ format: "openmasu-capacity-v1", status: "unavailable", reason, production_capacity_verified: false }));
  process.exitCode = 2;
}
