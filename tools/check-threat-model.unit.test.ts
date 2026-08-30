import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertThreatModelCoverage } from "./check-threat-model.js";

describe("threat-model coverage gate", () => {
  it("accepts the same runtime component set regardless of marker order", () => {
    const architecture = "<!-- m1-component:api -->\n<!-- m1-component:worker -->";
    const threats = "<!-- threat-component:worker -->\n<!-- threat-component:api -->";
    assert.equal(assertThreatModelCoverage(architecture, threats), 2);
  });

  it("rejects a threat model that omits an architecture component", () => {
    const architecture = "<!-- m1-component:api -->\n<!-- m1-component:worker -->";
    const threats = "<!-- threat-component:api -->";
    assert.throws(
      () => assertThreatModelCoverage(architecture, threats),
      /threat model component coverage differs: architecture=api,worker threats=api/,
    );
  });

  it("keeps the threat-model gate in the root validation command", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.match(scripts.scripts.validate, /(?:^|&&\s*)npm run check:threat-model(?:\s*&&|$)/);
  });
});
