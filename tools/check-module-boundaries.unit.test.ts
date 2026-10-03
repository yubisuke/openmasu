import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkModuleBoundaries, inspectWorkspaceBoundaries, type BoundaryModule, type Workspace } from "./check-module-boundaries.js";

const workspace = (name: string, directory: string, dependencies: Record<string, string> = {}, devDependencies: Record<string, string> = {}): Workspace => ({ name, directory, dependencies, devDependencies });
const module = (path: string, specifier: string, target: string, typeOnly = false): BoundaryModule => ({ path, imports: [{ specifier, target, typeOnly }] });

describe("module_boundaries_reject_invalid_edges", () => {
  it("rejects executable-app private imports", () => {
    const errors = checkModuleBoundaries([module("apps/api/src/report.ts", "../../worker/src/import.ts", "apps/worker/src/import.ts")], [workspace("@openmasu/api", "apps/api"), workspace("@openmasu/worker", "apps/worker")], []);
    assert.ok(errors.some(error => error.includes("executable app dependency")));
    assert.ok(errors.some(error => error.includes("private cross-workspace")));
  });
  it("requires runtime declarations while allowing declared type-only library dependencies", () => {
    const owners = [workspace("@openmasu/runtime", "apps/runtime", {}, { "@openmasu/contracts": "0.4.0" }), workspace("@openmasu/contracts", "packages/contracts")];
    const entry = module("apps/runtime/src/report.ts", "@openmasu/contracts/types", "packages/contracts/src/types.ts", true);
    assert.deepEqual(checkModuleBoundaries([entry], owners, []), []);
    assert.match(checkModuleBoundaries([{ ...entry, imports: entry.imports.map(value => ({ ...value, typeOnly: false })) }], owners, [])[0], /undeclared runtime/);
  });
  it("detects transitive IO behind a nominally pure entrypoint", () => {
    const modules = [module("packages/contracts/src/definitions.ts", "./validation.js", "packages/contracts/src/validation.ts"), { path: "packages/contracts/src/validation.ts", imports: [{ specifier: "node:fs", typeOnly: false }] }];
    assert.match(checkModuleBoundaries(modules, [workspace("@openmasu/contracts", "packages/contracts")], [modules[0].path])[0], /IO dependency/);
  });
  it("rejects runtime cycles but permits a type-only return edge", () => {
    const owners = [workspace("@openmasu/core", "packages/core", { "@openmasu/contracts": "1" }), workspace("@openmasu/contracts", "packages/contracts", { "@openmasu/core": "1" })];
    const modules = [module("packages/core/src/main.ts", "@openmasu/contracts", "packages/contracts/src/main.ts"), module("packages/contracts/src/main.ts", "@openmasu/core", "packages/core/src/main.ts")];
    assert.ok(checkModuleBoundaries(modules, owners, []).some(error => error.includes("runtime workspace cycle")));
    assert.deepEqual(checkModuleBoundaries([modules[0], { ...modules[1], imports: modules[1].imports.map(value => ({ ...value, typeOnly: true })) }], owners, []), []);
  });
  it("dashboard_presentation_excludes_io_modules and keeps the other lightweight entrypoints pure", () => {
    assert.deepEqual(inspectWorkspaceBoundaries(process.cwd()).errors, []);
    const root = "apps/api/src/dashboard/presenter.ts";
    const owners = [workspace("@openmasu/api", "apps/api")];
    for (const specifier of ["node:fs", "pg", "ajv/dist/2020.js", "@openmasu/contracts/validation"]) {
      assert.ok(checkModuleBoundaries([{ path: root, imports: [{ specifier, typeOnly: false }] }], owners, [root])
        .some(error => error.includes("IO dependency")), specifier);
    }
    assert.ok(checkModuleBoundaries([{ path: root, imports: [], performsIO: true }], owners, [root])
      .some(error => error.includes("IO in")));
  });
});
