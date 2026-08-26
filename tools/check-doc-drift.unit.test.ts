import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentationDriftFailures, parseValidationSummary, type CurrentDocumentation } from "./check-doc-drift.js";

const summary = "Validated 28 schemas, 8 registries, 56 reviewed fixtures, 728 golden output artifacts, 56 scenario assertions, 27 acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.";
const version = "0.2.0-rc.2";

function documents(): CurrentDocumentation {
  return {
    readme: `The current source and SDK release candidate is \`v${version}\`. Validation checks 28 schemas, 8 registries, 56 reviewed synthetic fixtures, 728 golden output artifacts, 56 scenario assertions, 27 acceptance criteria.`,
    roadmap: "The current gate preserves parity across 28 schemas, 8 registries, and 56 reviewed synthetic fixtures.",
    releaseRunbook: `Use build/sdk-release/openmasu-sdk-${version}.`,
    releaseNotes: `# OpenMasu v${version}`,
    specification: `The literal validation summary is: \`${summary}\``,
    status: `Checked for the \`v${version}\` release candidate.`,
  };
}

describe("documentation drift check", () => {
  it("parses the measured validation inventory", () => {
    assert.deepEqual(parseValidationSummary(summary), {
      schemas: 28,
      registries: 8,
      fixtures: 56,
      goldenArtifacts: 728,
      scenarios: 56,
      acceptanceCriteria: 27,
    });
  });

  it("accepts matching current documentation while ignoring unrelated historical text", () => {
    const current = documents();
    current.roadmap = `Historical: 27 schemas and 47 fixtures. ${current.roadmap}`;
    assert.deepEqual(documentationDriftFailures(current, summary, version), []);
  });

  it("reports validation-summary and release-identity drift", () => {
    const current = documents();
    current.specification = current.specification.replace("728 golden", "727 golden");
    current.status = current.status.replace(version, "0.1.0");
    assert.deepEqual(documentationDriftFailures(current, summary, version), [
      "the normative specification does not contain the measured validation summary",
      "STATUS release candidate differs from the SDK release version",
    ]);
  });
});
