import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jcs, sha256 } from "@openmasu/attribution-core";
import { createSeedPool } from "@openmasu/runtime";
import { parityKinds, parityLedgerTable, type ParityKind } from "./ingestion.js";

type Any = Record<string, any>;
const d0Metrics = new Set([
  "d0_install_to_24h_ad_revenue_usd",
  "d0_utc_install_calendar_ad_revenue_usd",
  "d0_jst_install_calendar_ad_revenue_usd",
]);
const fixtureRoot = join(process.cwd(), "fixtures", "v0.4");
const fixtureNames = readdirSync(fixtureRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function expected(fixtureName: string, kind: ParityKind): Any[] {
  const values: Any[] = JSON.parse(
    readFileSync(join(fixtureRoot, fixtureName, `expected_${kind}.json`), "utf8"),
  );
  return kind === "metric_runs"
    ? values.filter((run) => d0Metrics.has(run.metric_name) && run.grouping === undefined)
    : values;
}

function bytes(value: unknown): Buffer {
  return Buffer.from(jcs(value), "utf8");
}

const pool = createSeedPool();
let artifactCount = 0;
try {
  const runs = await pool.query<{ fixture_name: string }>(
    "SELECT fixture_name FROM testing.fixture_runs ORDER BY fixture_name",
  );
  assert.deepEqual(runs.rows.map((row) => row.fixture_name), fixtureNames, "seed did not cover every fixture");
  for (const fixtureName of fixtureNames) {
    for (const kind of parityKinds) {
      const database = await pool.query<{
        ordinal: number;
        source_table: string;
        artifact_digest: string;
        artifact: Any;
      }>(
        `SELECT ordinal, source_table, artifact_digest, artifact
         FROM testing.fixture_artifacts
         WHERE fixture_name = $1 AND artifact_kind = $2
         ORDER BY ordinal`,
        [fixtureName, kind],
      );
      const actual: Any[] = [];
      for (const [index, row] of database.rows.entries()) {
        assert.equal(row.ordinal, index, `${fixtureName}/${kind} ordinal gap`);
        assert.equal(row.source_table, parityLedgerTable[kind], `${fixtureName}/${kind}/${index} source table drift`);
        assert.equal(row.artifact_digest, sha256(row.artifact), `${fixtureName}/${kind}/${index} digest drift`);
        actual.push(row.artifact);
      }
      const golden = expected(fixtureName, kind);
      assert.equal(
        Buffer.compare(bytes(actual), bytes(golden)),
        0,
        `${fixtureName}/${kind} differs from the reviewed golden after JCS`,
      );
      artifactCount += actual.length;
    }
  }
} finally {
  await pool.end();
}

console.log(`Runtime parity passed: ${fixtureNames.length} fixtures, ${parityKinds.length} artifact families, ${artifactCount} JCS byte-identical artifacts.`);
