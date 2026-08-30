import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type CurrentDocumentation = {
  readme: string;
  roadmap: string;
  releaseRunbook: string;
  releaseNotes: string;
  schemaVersioning: string;
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

const internalControlReferencePattern = /(?:\bWO-\d+\b|\bR-\d+\b|\bF-D-\d+\b|\bDL-D-\d+\b|review\/wo-|decision-pending)/i;

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

export function latestContractPatch(schemaVersioning: string): string {
  const versions = [...schemaVersioning.matchAll(/^\|\s*(\d+)\.(\d+)\.(\d+)\s*\|/gm)].map((match) => ({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }));
  assert.ok(versions.length > 0, "the schema-versioning patch ledger is empty");
  versions.sort((left, right) =>
    left.major - right.major || left.minor - right.minor || left.patch - right.patch,
  );
  const latest = versions.at(-1)!;
  return `${latest.major}.${latest.minor}.${latest.patch}`;
}

export function unexplainedControlReferenceFailures(documents: Readonly<Record<string, string>>): string[] {
  return Object.entries(documents)
    .filter(([, contents]) => internalControlReferencePattern.test(contents))
    .map(([path]) => `current documentation contains an internal work-order or decision reference: ${path}`);
}

export function documentationDriftFailures(
  documents: CurrentDocumentation,
  validationSummary: string,
  releaseVersion: string,
): string[] {
  const inventory = parseValidationSummary(validationSummary);
  const failures: string[] = [];
  const contractPatch = latestContractPatch(documents.schemaVersioning);
  const normalizedIncludes = (document: string, expected: string): boolean =>
    document.replace(/\s+/g, " ").includes(expected.replace(/\s+/g, " "));
  const expect = (condition: boolean, label: string): void => {
    if (!condition) failures.push(label);
  };
  const bundlePath = `build/sdk-release/openmasu-sdk-${releaseVersion}`;
  const readmeCandidate = normalizedIncludes(
    documents.readme,
    `source and SDK are configured for candidate \`v${releaseVersion}\``,
  );
  const readmePublished = normalizedIncludes(
    documents.readme,
    `\`v${releaseVersion}\` is the current published source and SDK release`,
  );
  const statusCandidate = normalizedIncludes(
    documents.status,
    `source and SDK are configured for candidate \`v${releaseVersion}\``,
  );
  const statusPublished = normalizedIncludes(
    documents.status,
    `\`v${releaseVersion}\` is the current published source and SDK release`,
  );

  expect(
    documents.specification.includes(`The literal validation summary is: \`${validationSummary.trim()}\``),
    "the normative specification does not contain the measured validation summary",
  );
  expect(
    normalizedIncludes(
      documents.readme,
      `checks ${inventory.schemas} schemas, ${inventory.registries} registries, ${inventory.fixtures} reviewed synthetic fixtures, ${inventory.goldenArtifacts} golden output artifacts, ${inventory.scenarios} scenario assertions, ${inventory.acceptanceCriteria} acceptance criteria`,
    ),
    "README validation inventory differs from the measured summary",
  );
  expect(
    normalizedIncludes(
      documents.roadmap,
      `across ${inventory.schemas} schemas, ${inventory.registries} registries, and ${inventory.fixtures} reviewed synthetic fixtures`,
    ),
    "the current M0.4 roadmap gate differs from the measured inventory",
  );
  expect(readmeCandidate || readmePublished, "README release identity differs from the SDK release version");
  expect(statusCandidate || statusPublished, "STATUS release identity differs from the SDK release version");
  expect(
    ((readmeCandidate && normalizedIncludes(documents.readme, "candidate is published only if the matching annotated tag")) ||
      (readmePublished &&
        normalizedIncludes(documents.readme, "Later `main` commits are not evidence for that release") &&
        documents.readme.includes(`/releases/tag/v${releaseVersion}`))) &&
      documents.readme.includes(`v${contractPatch}`),
    "README does not bind release state, exact evidence scope, and the active contract patch",
  );
  expect(
    documents.status.includes("current `main` source tree") &&
      documents.status.includes(`through v${contractPatch}`),
    "STATUS does not identify the active contract patch as current development source",
  );
  expect(
    normalizedIncludes(documents.readme, "An untagged bundle is only a local candidate artifact"),
    "README does not prevent an untagged bundle from being treated as release evidence",
  );
  expect(
    normalizedIncludes(documents.releaseRunbook, "must not be treated as published unless") &&
      normalizedIncludes(documents.releaseRunbook, "matching annotated tag and GitHub Release point to the same green commit"),
    "release runbook does not separate a configured candidate from a published release",
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

function currentMarkdownDocuments(root: string): Record<string, string> {
  const paths = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
  const walk = (relativeDirectory: string): void => {
    for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${entry.name}`.replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (relativePath === "docs/review" || relativePath === "docs/releases") continue;
        walk(relativePath);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".md") &&
        !/^contract-v.+-migration\.md$/.test(entry.name)
      ) {
        paths.push(relativePath);
      }
    }
  };
  walk("docs");
  walk("spec");
  return Object.fromEntries(paths.map((path) => [path, readFileSync(join(root, path), "utf8")]));
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
      schemaVersioning: read("docs/schema-versioning.md"),
      specification: read("spec/event-metric-contract-v0.4.md"),
      status: read("docs/STATUS.md"),
    },
    validationSummary,
    releaseVersion,
  );
  failures.push(...unexplainedControlReferenceFailures(currentMarkdownDocuments(root)));
  assert.deepEqual(failures, [], `documentation drift detected:\n${failures.join("\n")}`);
  console.log(`Documentation drift check passed for ${validationSummary}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) checkDocumentationDrift();
