import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workspaces = [
  "@open-mmp/api",
  "@open-mmp/runtime",
  "@open-mmp/worker",
  "@open-mmp/attribution-core",
  "@open-mmp/contracts",
];
const root = join(process.cwd(), "sbom");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("npm_execpath is unavailable; run this tool through npm run sbom");
for (const workspace of workspaces) {
  const result = spawnSync(process.execPath, [npmCli, "sbom", "--workspace", workspace, "--sbom-format", "cyclonedx"], {
    cwd: process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`SBOM failed for ${workspace}: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  const value = JSON.parse(result.stdout);
  if (value.bomFormat !== "CycloneDX" || !Array.isArray(value.components)) {
    throw new Error(`SBOM for ${workspace} is not a CycloneDX document`);
  }
  const name = workspace.replace("@open-mmp/", "");
  writeFileSync(join(root, `${name}.cdx.json`), `${JSON.stringify(value, null, 2)}\n`);
}
for (const workspace of workspaces) {
  const name = workspace.replace("@open-mmp/", "");
  JSON.parse(readFileSync(join(root, `${name}.cdx.json`), "utf8"));
}
console.log(`Generated ${workspaces.length} CycloneDX workspace SBOMs.`);
