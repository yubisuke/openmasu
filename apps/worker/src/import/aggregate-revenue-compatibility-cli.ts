import { resolve } from "node:path";
import { reportAggregateRevenueCompatibilityFile } from "./aggregate-revenue-compatibility.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const file = argument("file");
  if (!file) throw new Error("usage: npm run import:revenue:compatibility -- --file=<json>");
  try {
    console.log(JSON.stringify(reportAggregateRevenueCompatibilityFile({ filePath: resolve(file) })));
  } catch {
    console.error(JSON.stringify({ error: "aggregate_compatibility_failed" }));
    process.exitCode = 1;
  }
}
