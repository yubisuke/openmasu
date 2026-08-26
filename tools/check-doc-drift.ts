import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type CurrentDocumentation = {
  readme: string;
  roadmap: string;
  releaseRunbook: string;
  releaseNotes: string;
  specification: string;
  status: string;
};

export type ValidationInventory = {
  acceptanceCriteria: number;
  fixtures: number;
  goldenArtifacts: number;
  registries: number;
  scenarios: number;
  schemas: number;
};

const summaryPattern = /^Validated (\d+) schemas, (\d+) registries, (\d+) reviewed fixtures, (\d+) golden output artifacts, (\d+) scenario assertions, (\d+) acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance\.$/;

export function parseValidationSummary(summary: string): ValidationInventory {
  const match = summary.trim().match(summaryPattern);
  assert.ok(match, `unexpected validation summary: ${summary.trim()}`);
  return {
    schemas: Number(match[1]),
    registries: Number(match[2]),
    fixtures: Number(match[3]),
    goldenArtifacts: Number(match[4]),
    scenarios: Number(match[5]),
    acceptanceCriteria: Number(match[6]),
  };
}

export function documentationDriftFailures(
  documents: CurrentDocumentation,
  validationSummary: string,
  releaseVersion: string,
): string[] {
  const inventory = parseValidationSummary(validationSummary);
  const failures: string[] = [];
  const expect = (condition: boolean, label: string): void => {
    if (!condition) failures.push(label);
  };
  const bundlePath = `build/sdk-release/openmasu-sdk-${releaseVersion}`;

  expect(
    documents.specification.includes(`The literal validation summary is: \`${validationSummary.trim()}\``),
    "the normative specification does not contain the measured validation summary",
  );
  expect(
    documents.readme.includes(
      `checks ${inventory.schemas} schemas, ${inventory.registries} registries, ${inventory.fixtures} reviewed synthetic fixtures, ${inventory.goldenArtifacts} golden output artifacts, ${inventory.scenarios} scenario assertions, ${inventory.acceptanceCriteria} acceptance criteria`,
    ),
    "README validation inventory differs from the measured summary",
  );
  expect(
    documents.roadmap.includes(
      `across ${inventory.schemas} schemas, ${inventory.registries} registries, and ${inventory.fixtures} reviewed synthetic fixtures`,
    ),
    "the current M0.4 roadmap gate differs from the measured inventory",
  );
  expect(
    documents.readme.includes(`current source and SDK release candidate is \`v${releaseVersion}\``),
    "README release candidate differs from the SDK release version",
  );
  expect(
    documents.status.includes(`for the \`v${releaseVersion}\` release candidate`),
    "STATUS release candidate differs from the SDK release version",
  );
  expect(documents.releaseRunbook.includes(bundlePath), "release runbook bundle path differs from the SDK release version");
  expect(documents.releaseNotes.includes(`# OpenMasu v${releaseVersion}`), "release notes heading differs from the SDK release version");
  return failures;
}

function readReleaseVersion(root: string): string {
  const android = readFileSync(join(root, "sdk/android/build.gradle.kts"), "utf8");
  const match = android.match(/^version = "([^"]+)"$/m);
  assert.ok(match, "Android SDK release version is missing");
  return match[1];
}

export function checkDocumentationDrift(root = process.cwd()): void {
  const validationSummary = execFileSync(
    process.execPath,
    ["--import", "tsx", "tools/validate.ts", "--summary"],
    { cwd: root, encoding: "utf8", env: process.env },
  ).trim();
  const releaseVersion = readReleaseVersion(root);
  const read = (path: string): string => readFileSync(join(root, path), "utf8");
  const failures = documentationDriftFailures(
    {
      readme: read("README.md"),
      roadmap: read("docs/roadmap.md"),
      releaseRunbook: read("docs/operations/release.md"),
      releaseNotes: read(`docs/releases/v${releaseVersion}.md`),
      specification: read("spec/event-metric-contract-v0.4.md"),
      status: read("docs/STATUS.md"),
    },
    validationSummary,
    releaseVersion,
  );
  assert.deepEqual(failures, [], `documentation drift detected:\n${failures.join("\n")}`);
  console.log(`Documentation drift check passed for ${validationSummary}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) checkDocumentationDrift();
