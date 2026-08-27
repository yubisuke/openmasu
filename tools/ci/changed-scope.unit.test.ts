import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPaths } from "./changed-scope.mjs";

describe("CI changed-scope classifier", () => {
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
