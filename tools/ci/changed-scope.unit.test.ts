import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { classifyPaths } from "./changed-scope.mjs";

describe("CI changed-scope classifier", () => {
  it("keeps offline comparison validation without native or database gates", () => {
    assert.deepEqual(classifyPaths(["tools/compare-cohorts.ts", "tools/cohort-comparison-html.ts", "tools/report-to-snapshot.ts", "tools/report-to-snapshot.unit.test.ts", "examples/synthetic/cohort-snapshot.json", "docs/cohort-comparison.md"]), {
      contract: true, runtime: false, android: false, android_emulator: false, ios: false, runtime_performance: false, offline_unit: true,
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
      contract: true, runtime: false, android: false, android_emulator: false, ios: false, runtime_performance: false,
    });
    assert.deepEqual(classifyPaths(["README.md","docs/getting-started.md"],"push"),classifyPaths(["README.md","docs/getting-started.md"]));
  });

  it("runs only runtime for application and database implementation changes", () => {
    assert.deepEqual(classifyPaths(["apps/worker/src/main.ts", "db/schema.sql"]), {
      contract: false, runtime: true, android: false, android_emulator: false, ios: false, runtime_performance: true,
    });
    const html = ["apps/api/src/dashboard/render.ts","docs/development.md"];
    assert.equal(classifyPaths(html).runtime,true);
    assert.equal(classifyPaths(html).runtime_performance,false);
    assert.equal(classifyPaths(html,"push").runtime_performance,true);
    for (const path of ["apps/worker/src/import/runner.ts","apps/runtime/src/index.ts","apps/api/src/sdk-routes.ts","packages/contracts/src/index.ts","package-lock.json","unclassified.file"]) {
      assert.equal(classifyPaths([...html,path]).runtime_performance,true,path);
    }
    for (const event of ["pull_request", "push"] as const) {
      for (const path of ["apps/api/src/dashboard/dashboard.unit.test.ts", "packages/fraud-rules/src/fraud-rules.unit.test.ts", "tools/check-doc-links.unit.test.ts"]) {
        assert.deepEqual(classifyPaths([path, "docs/development.md"], event), {
          contract: true, runtime: true, android: false, android_emulator: false, ios: false, runtime_performance: false,
        }, `${event}: ${path}`);
        for (const implementation of ["apps/worker/src/import/runner.ts", "packages/contracts/src/index.ts", "tools/check-doc-links.ts", "package-lock.json", ".github/workflows/runtime.yml", "unclassified.file"]) {
          assert.equal(classifyPaths([path, implementation], event).runtime_performance, true, implementation);
        }
        assert.equal(classifyPaths([path, "sdk/android/core/src/main/example.kt"], event).android_emulator, true);
        assert.equal(classifyPaths([path, "sdk/ios/Sources/OpenMasuCore/Storage.swift"], event).ios, true);
      }
    }
    assert.equal(classifyPaths(["unknown-folder/example.unit.test.ts"]).android_emulator, true);
  });

  it("runs contract and both native gates for any SDK release surface", () => {
    assert.deepEqual(classifyPaths(["sdk/ios/Sources/OpenMasuCore/Storage.swift"]), {
      contract: true, runtime: false, android: true, android_emulator: false, ios: true, runtime_performance: false,
    });
  });

  it("runs contract and runtime for shared contract surfaces", () => {
    assert.deepEqual(classifyPaths(["packages/contracts/src/index.ts", "fixtures/v0.4/README.md"]), {
      contract: true, runtime: true, android: false, android_emulator: false, ios: false, runtime_performance: true,
    });
  });

  it("fails open for workflow, tooling, dependency, and unknown paths", () => {
    for (const path of [".github/workflows/runtime.yml", "tools/sbom.ts", "package-lock.json", "unclassified.file"]) {
      assert.deepEqual(classifyPaths([path]), {
        contract: true, runtime: true, android: true, android_emulator: true, ios: true, runtime_performance: true,
      }, path);
    }
    const scripts = JSON.parse(readFileSync("package.json","utf8")).scripts as Record<string,string>;
    const runtime = readFileSync(".github/workflows/runtime.yml","utf8");
    for (const command of ["npm test", "npm run test:integration", "npm run test:db-invariants"]) {
      assert.equal(runtime.split(/\r?\n/).filter(line => line.trim() === command).length, 1, `${command} must have one CI owner`);
    }
    assert.equal((runtime.match(/\bnpm run test:backup-restore\b/g) ?? []).length, 1, "backup/restore must not repeat its entire suite");
    const databaseScripts = JSON.parse(readFileSync("apps/runtime/package.json", "utf8")).scripts as Record<string,string>;
    for (const command of [scripts["test:backup-restore"], databaseScripts["test:db-invariants"]]) {
      const files = command.match(/apps\/[^\s"]+\.ts/g) ?? [];
      assert.ok(files.length > 0, "dedicated database suites retain their test files");
      for (const file of files) {
        assert.ok(!file.endsWith(".integration.test.ts") && !file.endsWith(".unit.test.ts"), `${file} is duplicated by a bulk suite`);
        readFileSync(file, "utf8");
      }
    }
    for (const alias of ["test:m2a","test:financial-parity","test:dashboard-parity"]) {
      const files = scripts[alias].match(/(?:apps|packages)\/[^\s"]+\.ts/g) ?? [];
      assert.ok(files.length > 0,alias);
      for (const file of files) {
        const suite = file.endsWith(".unit.test.ts") ? "test" : file.endsWith(".integration.test.ts") ? "test:integration" : undefined;
        assert.ok(suite,`${alias} contains a test outside the bulk suites: ${file}`);
        const root = file.split("/",1)[0], suffix = file.endsWith(".unit.test.ts") ? "unit" : "integration";
        assert.ok(scripts[suite].includes(`${root}/**/*.${suffix}.test.ts`),`${alias} lost its CI owner: ${file}`);
      }
      assert.ok(!runtime.includes(`run: npm run ${alias}`),`${alias} repeats a bulk suite`);
    }
    assert.ok(!runtime.includes("run: npm run verify:consistency"));
  });

  it("runs the emulator only for Android source changes", () => {
    assert.deepEqual(classifyPaths(["sdk/android/core/src/main/example.kt"]), {
      contract: true, runtime: false, android: true, android_emulator: true, ios: false, runtime_performance: false,
    });
  });
});
