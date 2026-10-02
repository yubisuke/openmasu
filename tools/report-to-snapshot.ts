import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "@openmasu/attribution-core";
import { reportToSnapshot } from "../apps/api/src/report-snapshot.js";
import { aggregateCsvToSnapshot, AggregateCsvError, csvLimits } from "../apps/api/src/aggregate-csv-snapshot.js";
export { reportToSnapshot } from "../apps/api/src/report-snapshot.js";
export { aggregateCsvToSnapshot, AggregateCsvError } from "../apps/api/src/aggregate-csv-snapshot.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rawArgs = process.argv.slice(2), csv = rawArgs.includes("--csv"), args = rawArgs.filter(arg => arg !== "--csv");
    if (args.length !== 2) throw Error("expected_report_and_template");
    if (csv) {
      if (args.some(path => statSync(path).size > csvLimits.bytes)) throw new AggregateCsvError("input_byte_limit");
      let mapping: unknown; try { mapping = JSON.parse(readFileSync(args[1], "utf8")); } catch { throw new AggregateCsvError("mapping_invalid"); }
      process.stdout.write(`${jcs(aggregateCsvToSnapshot(readFileSync(args[0]), mapping))}\n`);
    } else {
      const [report, template] = args.map(path => {
        if (statSync(path).size > 4 * 1024 * 1024) throw Error("input_too_large");
        return JSON.parse(readFileSync(path, "utf8"));
      });
      process.stdout.write(`${jcs(reportToSnapshot(report, template))}\n`);
    }
  } catch (error) {
    if (process.argv.includes("--csv")) console.error(JSON.stringify({ error: error instanceof AggregateCsvError
      ? { code: error.code, row_number: error.row_number } : { code: "conversion_failed", row_number: null } }));
    else console.error("Snapshot conversion failed: check complete report and explicit template; inputs were not printed.");
    process.exitCode = 1;
  }
}
