import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@open-mmp/attribution-core";
import { createAppPool, createSeedPool } from "@open-mmp/runtime";
import { ingestFixture } from "./ingestion.js";

type Any = Record<string, any>;

const fixtureRoot = join(process.cwd(), "fixtures", "v0.2");
const fixtureNames = readdirSync(fixtureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const appPool = createAppPool();
const seedPool = createSeedPool();
let artifactCount = 0;

try {
  for (const fixtureName of fixtureNames) {
    const input: Any = JSON.parse(readFileSync(join(fixtureRoot, fixtureName, "input.json"), "utf8"));
    const inputDigest = sha256(input);
    await seedPool.query(
      `INSERT INTO testing.fixture_inputs (fixture_name, input_digest, input)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (fixture_name) DO UPDATE
       SET input_digest=EXCLUDED.input_digest, input=EXCLUDED.input`,
      [fixtureName, inputDigest, JSON.stringify(input)],
    );
    const stored = await seedPool.query<{ input: Any; input_digest: string }>(
      "SELECT input, input_digest FROM testing.fixture_inputs WHERE fixture_name = $1",
      [fixtureName],
    );
    if (stored.rows[0].input_digest !== inputDigest) throw new Error(`fixture input digest drift: ${fixtureName}`);
    try {
      artifactCount += await ingestFixture(fixtureName, stored.rows[0].input, appPool, seedPool);
    } catch (error) {
      throw new Error(`fixture ingestion failed: ${fixtureName}`, { cause: error });
    }
  }
} finally {
  await appPool.end();
  await seedPool.end();
}

console.log(`Seeded ${fixtureNames.length} synthetic fixtures through PostgreSQL ingestion (${artifactCount} parity artifacts).`);
