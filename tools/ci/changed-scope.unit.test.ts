import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPaths } from "./changed-scope.mjs";

describe("CI changed-scope classifier", () => {
  it("keeps offline comparison validation without native or database gates", () => {
    assert.deepEqual(classifyPaths(["tools/compare-cohorts.ts", "tools/cohort-comparison-html.ts", "tools/report-to-snapshot.ts", "tools/report-to-snapshot.unit.test.ts", "examples/synthetic/cohort-snapshot.json", "docs/cohort-comparison.md"]), {
      contract: true, runtime: false, android: false, android_emulator: false, ios: false, offline_unit: true,
    });
  });

  it("does not let an offline tool suppress shared dependency or runtime changes", () => {
    for (const path of ["package-lock.json", "tools/new-unknown-tool.ts", ".github/workflows/contract.yml"]) {
      const scope = classifyPaths(["tools/compare-cohorts.ts", path]);
      assert.equal(scope.runtime, true); assert.equal(scope.ios, true); assert.equal(scope.android_emulator, true);
    }
    assert.equal(classifyPaths(["tools/compare-cohorts.ts", "apps/api/src/reporting.ts"]).runtime, true);
  });
  it("keeps documentation checks while skipping unrelated expensive gates", () => {
    assert.deepEqual(classifyPaths(["README.md", "docs/getting-started.md"]), {
      contract: true, runtime: false, android: false, android_emulator: false, ios: false,
    });
  });

  it("runs only runtime for application and database implementation changes", () => {
    assert.deepEqual(classifyPaths(["apps/worker/src/main.ts", "db/schema.sql"]), {
      contract: false, runtime: true, android: false, android_emulator: false, ios: false,
    });
  });

  it("runs contract and both native gates for any SDK release surface", () => {
    assert.deepEqual(classifyPaths(["sdk/ios/Sources/OpenMasuCore/Storage.swift"]), {
      contract: true, runtime: false, android: true, android_emulator: false, ios: true,
    });
  });

  it("runs contract and runtime for shared contract surfaces", () => {
    assert.deepEqual(classifyPaths(["packages/contracts/src/index.ts", "fixtures/v0.4/README.md"]), {
      contract: true, runtime: true, android: false, android_emulator: false, ios: false,
    });
  });

  it("fails open for workflow, tooling, dependency, and unknown paths", () => {
    for (const path of [".github/workflows/runtime.yml", "tools/sbom.ts", "package-lock.json", "unclassified.file"]) {
      assert.deepEqual(classifyPaths([path]), {
        contract: true, runtime: true, android: true, android_emulator: true, ios: true,
      }, path);
    }
  });

  it("runs the emulator only for Android source changes", () => {
    assert.deepEqual(classifyPaths(["sdk/android/core/src/main/example.kt"]), {
      contract: true, runtime: false, android: true, android_emulator: true, ios: false,
    });
  });
});
