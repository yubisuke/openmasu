import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "@openmasu/attribution-core";
import { compareSnapshots } from "../apps/api/src/cohort-comparison.js";
import { renderComparison } from "../apps/api/src/dashboard/comparison-report.js";
export * from "../apps/api/src/cohort-comparison.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const rawArgs = process.argv.slice(2), html = rawArgs.includes("--html"), declaredOnly = rawArgs.includes("--declared");
    const allowExternalDeclaration = rawArgs.includes("--external-declared");
    const args = rawArgs.filter(value => !["--html", "--declared", "--external-declared"].includes(value));
    if (args.length !== 2) throw Error("expected_two_snapshots");
    const inputs = args.map(path => {
      if (statSync(path).size > 4 * 1024 * 1024) throw Error("input_too_large");
      return JSON.parse(readFileSync(path, "utf8"));
    });
    const comparison = compareSnapshots(inputs[0], inputs[1], { declaredOnly, allowExternalDeclaration });
    process.stdout.write(html ? renderComparison(comparison) : `${jcs(comparison)}\n`);
  } catch { console.error("Comparison failed: check arguments and snapshot format; inputs were not printed."); process.exitCode = 1; }
}
