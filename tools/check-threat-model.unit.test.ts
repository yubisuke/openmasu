import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertThreatModelCoverage } from "./check-threat-model.js";

describe("threat-model coverage gate", () => {
  const threat = (component: string) => [
    `<!-- threat-component:${component} -->`,
    `**${component}:** forged input, replay, and cross-scope access.\nControls include strict authentication, bounded input, and immutable audit evidence.`,
  ].join("\n");

  it("accepts the same runtime component set regardless of marker order", () => {
    const architecture = "<!-- m1-component:api -->\n<!-- m1-component:worker -->";
    const threats = `${threat("worker")}\n${threat("api")}`;
    assert.equal(assertThreatModelCoverage(architecture, threats), 2);
  });

  it("rejects a threat model that omits an architecture component", () => {
    const architecture = "<!-- m1-component:api -->\n<!-- m1-component:worker -->";
    const threats = threat("api");
    assert.throws(
      () => assertThreatModelCoverage(architecture, threats),
      /threat model component coverage differs: architecture=api,worker threats=api/,
    );
  });

  it("rejects an empty component section even when its marker is present", () => {
    assert.throws(
      () => assertThreatModelCoverage("<!-- m1-component:api -->", "<!-- threat-component:api -->"),
      /threat component api has no explicit component label/,
    );
  });

  it("rejects components without substantive risk and control descriptions", () => {
    assert.throws(
      () => assertThreatModelCoverage(
        "<!-- m1-component:api -->",
        "<!-- threat-component:api -->\n**API:** Controls include strict authentication and immutable audit evidence.",
      ),
      /threat component api has no substantive risk description/,
    );
    assert.throws(
      () => assertThreatModelCoverage(
        "<!-- m1-component:api -->",
        "<!-- threat-component:api -->\n**API:** forged input, replay, and cross-scope access.",
      ),
      /threat component api has no Controls statement/,
    );
  });

  it("keeps the threat-model gate in the root validation command", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.match(scripts.scripts.validate, /(?:^|&&\s*)npm run check:threat-model(?:\s*&&|$)/);
  });
});
