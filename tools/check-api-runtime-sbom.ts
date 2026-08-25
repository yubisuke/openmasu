import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Component = { readonly name?: unknown; readonly scope?: unknown };
const baseline = JSON.parse(readFileSync(
  join(process.cwd(), "tools", "api-runtime-components.json"),
  "utf8",
)) as string[];
const sbom = JSON.parse(readFileSync(
  join(process.cwd(), "sbom", "api.cdx.json"),
  "utf8",
)) as { readonly bomFormat?: unknown; readonly components?: Component[] };
assert.equal(sbom.bomFormat, "CycloneDX");
assert.ok(Array.isArray(sbom.components));
const runtimeComponents = sbom.components
  .filter((component) => component.scope === "required")
  .map((component) => {
    assert.equal(typeof component.name, "string");
    return component.name as string;
  })
  .sort();
assert.deepEqual(
  runtimeComponents,
  [...baseline].sort(),
  "@openmasu/api runtime component set grew or shrank; review the M3 zero-dependency invariant",
);
console.log(`API runtime SBOM baseline passed: ${runtimeComponents.length} required components.`);
