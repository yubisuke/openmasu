import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

// The npm 2.0.1 tarball omits the build and type directories declared by its manifest.
// Rebuild those artifacts from the published source without changing package behavior.
const packageRoot = resolve("node_modules", "json-canonicalize");
const manifestPath = resolve(packageRoot, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.name !== "json-canonicalize" || manifest.version !== "2.0.1") {
  throw new Error(
    `Expected json-canonicalize 2.0.1, received ${manifest.name} ${manifest.version}`,
  );
}

const sourceRoot = resolve(packageRoot, "src");
const sourceFiles = [
  "canonicalize-ex.ts",
  "canonicalize.ts",
  "environment.ts",
  "global.ts",
  "index.ts",
  "serializer.ts",
].map((name) => resolve(sourceRoot, name));

const outputRoots = {
  commonJs: resolve(packageRoot, "bundles"),
  es2015: resolve(packageRoot, "esm2015"),
  es5: resolve(packageRoot, "esm5"),
  types: resolve(packageRoot, "types"),
};

for (const outputRoot of Object.values(outputRoots)) {
  rmSync(outputRoot, { force: true, recursive: true });
  mkdirSync(outputRoot, { recursive: true });
}

function emit(options) {
  const program = ts.createProgram(sourceFiles, {
    noEmitOnError: true,
    rootDir: sourceRoot,
    skipLibCheck: true,
    strict: true,
    ...options,
  });
  const result = program.emit();
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .concat(result.diagnostics)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);

  if (diagnostics.length > 0 || result.emitSkipped) {
    const host = {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    };
    throw new Error(ts.formatDiagnostics(diagnostics, host));
  }
}

emit({
  declaration: true,
  declarationDir: outputRoots.types,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  outDir: outputRoots.commonJs,
  target: ts.ScriptTarget.ES2018,
});
copyFileSync(
  resolve(outputRoots.commonJs, "index.js"),
  resolve(outputRoots.commonJs, "index.umd.js"),
);

for (const outDir of [outputRoots.es5, outputRoots.es2015]) {
  emit({
    module: ts.ModuleKind.ES2015,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    outDir,
    target: ts.ScriptTarget.ES2018,
  });
}

console.log("Rebuilt missing json-canonicalize 2.0.1 distribution artifacts.");
