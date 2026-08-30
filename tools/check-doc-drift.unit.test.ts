import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  documentationDriftFailures,
  latestContractPatch,
  parseValidationSummary,
  unexplainedControlReferenceFailures,
  type CurrentDocumentation,
} from "./check-doc-drift.js";

const summary = "Validated 28 schemas, 8 registries, 57 reviewed fixtures, 741 golden output artifacts, 57 scenario assertions, 27 acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.";
const version = "0.2.0";

function documents(): CurrentDocumentation {
  return {
    readme: `The source and SDK are configured for candidate \`v${version}\`. This candidate is published only if the matching annotated tag exists at v0.4.10. An untagged bundle is only a local candidate artifact. Validation checks 28 schemas, 8 registries, 57 reviewed synthetic fixtures,\n741 golden output artifacts, 57 scenario assertions, 27 acceptance criteria.`,
    roadmap: "The current gate preserves parity across 28 schemas, 8 registries, and 57 reviewed synthetic fixtures.",
    releaseRunbook: `Use build/sdk-release/openmasu-sdk-${version}. A candidate must not be treated as published unless the matching annotated tag and GitHub Release point to the same green commit.`,
    releaseNotes: `# OpenMasu v${version}`,
    schemaVersioning: "| Patch | Capability |\n| --- | --- |\n| 0.4.9 | Earlier |\n| 0.4.10 | Current |",
    specification: `The literal validation summary is: \`${summary}\``,
    status: `The source and SDK are configured for candidate \`v${version}\`. This document describes the current \`main\` source tree through v0.4.10.`,
  };
}

describe("documentation drift check", () => {
  it("parses the measured validation inventory", () => {
    assert.deepEqual(parseValidationSummary(summary), {
      schemas: 28,
      registries: 8,
      fixtures: 57,
      goldenArtifacts: 741,
      scenarios: 57,
      acceptanceCriteria: 27,
    });
  });

  it("derives the latest active contract patch from the version ledger", () => {
    assert.equal(latestContractPatch(documents().schemaVersioning), "0.4.10");
  });

  it("accepts matching current documentation while ignoring unrelated historical text", () => {
    const current = documents();
    current.roadmap = `Historical: 27 schemas and 47 fixtures. ${current.roadmap}`;
    assert.deepEqual(documentationDriftFailures(current, summary, version), []);
  });

  it("accepts a published release while keeping later main development separate", () => {
    const current = documents();
    current.readme = current.readme.replace(
      `The source and SDK are configured for candidate \`v${version}\`. This candidate is published only if the matching annotated tag exists at v0.4.10.`,
      `\`v${version}\` is the current published source and SDK release. Later \`main\` commits are not evidence for that release. https://github.com/yubisuke/openmasu/releases/tag/v${version} v0.4.10.`,
    );
    current.status = current.status.replace(
      `The source and SDK are configured for candidate \`v${version}\`. This document describes the current`,
      `\`v${version}\` is the current published source and SDK release. This document describes the later current`,
    );
    current.releaseRunbook = `Use build/sdk-release/openmasu-sdk-${version}. Future candidates must not be treated as published unless their matching annotated tag and GitHub Release point to the same green commit.`;
    assert.deepEqual(documentationDriftFailures(current, summary, version), []);
  });

  it("reports validation-summary and release-identity drift", () => {
    const current = documents();
    current.specification = current.specification.replace("741 golden", "740 golden");
    current.status = current.status.replace(version, "0.1.0");
    assert.deepEqual(documentationDriftFailures(current, summary, version), [
      "the normative specification does not contain the measured validation summary",
      "STATUS release identity differs from the SDK release version",
    ]);
  });

  it("reports an ambiguous post-tag development identity", () => {
    const current = documents();
    current.readme = current.readme.replace("This candidate is published only if the matching annotated tag exists at v0.4.10. ", "");
    assert.deepEqual(documentationDriftFailures(current, summary, version), [
      "README does not bind release state, exact evidence scope, and the active contract patch",
    ]);
  });

  it("rejects internal work-order and decision references in current documentation", () => {
    assert.deepEqual(
      unexplainedControlReferenceFailures({
        "docs/current.md": "Implement this in WO-99.",
        "docs/history.md": "A standalone historical explanation.",
      }),
      ["current documentation contains an internal work-order or decision reference: docs/current.md"],
    );
  });
});
