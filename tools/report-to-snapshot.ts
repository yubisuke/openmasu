import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "@openmasu/attribution-core";
import { reportToSnapshot } from "../apps/api/src/report-snapshot.js";
export { reportToSnapshot } from "../apps/api/src/report-snapshot.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) throw Error("expected_report_and_template");
    const [report, template] = args.map(path => {
      if (statSync(path).size > 4 * 1024 * 1024) throw Error("input_too_large");
      return JSON.parse(readFileSync(path, "utf8"));
    });
    process.stdout.write(`${jcs(reportToSnapshot(report, template))}\n`);
  } catch { console.error("Snapshot conversion failed: check complete report and explicit template; inputs were not printed."); process.exitCode = 1; }
}
