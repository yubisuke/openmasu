import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type Workspace = {
  name: string;
  directory: string;
  dependencies: Readonly<Record<string, string>>;
  devDependencies: Readonly<Record<string, string>>;
};
export type ModuleImport = { specifier: string; target?: string; typeOnly: boolean };
export type BoundaryModule = {
  path: string;
  imports: readonly ModuleImport[];
  performsIO?: boolean;
  privilegedIngestion?: boolean;
  ownsTransaction?: boolean;
};
const executableApps = new Set(["@openmasu/api", "@openmasu/worker", "@openmasu/redirector"]);
const forbiddenPureImport = /^(?:pg(?:\/|$)|ajv(?:-formats)?(?:\/|$)|@openmasu\/contracts\/validation(?:\/|$)|node:(?:fs|http|https|net|dns|child_process|worker_threads)(?:\/|$))/;
export const pureEntrypoints = [
  "packages/attribution-core/src/canonical.ts",
  "apps/runtime/src/import-normalization.ts",
  "packages/contracts/src/definitions.ts",
  "packages/contracts/src/types.ts",
  "apps/runtime/src/metric-comparison.ts",
  "apps/api/src/dashboard/presenter.ts",
  "apps/api/src/dashboard/render.ts",
  "apps/api/src/dashboard/action-pages.ts",
  "apps/api/src/dashboard/comparison-workflow.ts",
  "apps/api/src/dashboard/comparison-report.ts",
  "apps/api/src/dashboard/metric-schedules.ts",
  "apps/api/src/dashboard/metric-recalculations.ts",
  "apps/api/src/dashboard/metric-explanation.ts",
  "apps/api/src/dashboard/attribution-report.ts",
];
export const productionIngestionEntrypoints = ["apps/worker/src/ingestion.ts", "apps/worker/src/main.ts"];
const seedSupportModule = /^apps\/worker\/src\/(?:test-support\/|seed(?:-safety)?\.ts$|verify-parity\.ts$)/;
const clientOnlyRepository = /^apps\/worker\/src\/ingestion\/(?:record-repository|fact-projections|derived-repository|bulk-repository)\.ts$/;

/** Check production imports, not test fixtures or generated declarations. */
export function checkModuleBoundaries(
  modules: readonly BoundaryModule[],
  workspaces: readonly Workspace[],
  pureRoots: readonly string[] = pureEntrypoints,
  ingestionRoots: readonly string[] = [],
): string[] {
  const errors = new Set<string>();
  const byPath = new Map(modules.map(module => [module.path, module]));
  const byName = new Map(workspaces.map(workspace => [workspace.name, workspace]));
  const owner = (path: string) => workspaces.find(workspace => path.startsWith(`${workspace.directory}/`));
  const graph = new Map<string, Set<string>>();
  for (const module of modules) {
    const from = owner(module.path);
    if (!from) continue;
    for (const entry of module.imports) {
      const name = /^(@[^/]+\/[^/]+)/.exec(entry.specifier)?.[1];
      const to = entry.target ? owner(entry.target) : name ? byName.get(name) : undefined;
      if (name && byName.has(name) && name !== from.name) {
        const declared = from.dependencies[name] || (entry.typeOnly && from.devDependencies[name]);
        if (!declared) errors.add(`${module.path}: undeclared ${entry.typeOnly ? "type" : "runtime"} dependency ${name}`);
      }
      if (entry.typeOnly || !to || to.name === from.name) continue;
      if (executableApps.has(from.name) && executableApps.has(to.name)) {
        errors.add(`${module.path}: executable app dependency ${from.name} -> ${to.name}`);
      }
      if (entry.specifier.startsWith(".")) {
        errors.add(`${module.path}: private cross-workspace import ${entry.specifier}`);
      }
      if (!graph.has(from.name)) graph.set(from.name, new Set());
      graph.get(from.name)!.add(to.name);
    }
  }
  const visiting = new Set<string>(), complete = new Set<string>();
  function visit(name: string, chain: string[]): void {
    if (visiting.has(name)) { errors.add(`runtime workspace cycle: ${[...chain, name].join(" -> ")}`); return; }
    if (complete.has(name)) return;
    visiting.add(name);
    for (const next of graph.get(name) ?? []) visit(next, [...chain, name]);
    visiting.delete(name); complete.add(name);
  }
  for (const name of graph.keys()) visit(name, []);
  for (const root of pureRoots) {
    const visited = new Set<string>();
    function pure(path: string): void {
      if (visited.has(path)) return;
      visited.add(path);
      const module = byPath.get(path);
      if (!module) { errors.add(`${root}: missing pure module ${path}`); return; }
      if (module.performsIO) errors.add(`${root}: IO in ${path}`);
      for (const entry of module.imports.filter(item => !item.typeOnly)) {
        if (forbiddenPureImport.test(entry.specifier)) errors.add(`${root}: IO dependency ${entry.specifier} in ${path}`);
        if (entry.target && byPath.has(entry.target)) pure(entry.target);
      }
    }
    pure(root);
  }
  for (const root of ingestionRoots) {
    const visited = new Set<string>();
    function production(path: string): void {
      if (visited.has(path)) return;
      visited.add(path);
      const module = byPath.get(path);
      if (!module) { errors.add(`${root}: missing production ingestion module ${path}`); return; }
      if (seedSupportModule.test(path) || module.privilegedIngestion) {
        errors.add(`${root}: privileged seed/testing support in ${path}`);
      }
      if (clientOnlyRepository.test(path) && module.ownsTransaction) {
        errors.add(`${root}: repository owns a transaction in ${path}`);
      }
      for (const entry of module.imports.filter(item => !item.typeOnly)) {
        if (entry.target && byPath.has(entry.target)) production(entry.target);
      }
    }
    production(root);
  }
  return [...errors].sort();
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(?:test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function inspectWorkspaceBoundaries(root: string): { errors: string[]; moduleCount: number } {
  const normalize = (path: string) => relative(root, path).replaceAll("\\", "/");
  const workspaces: Workspace[] = ["apps", "packages"].flatMap(group =>
    readdirSync(resolve(root, group), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
      const directory = `${group}/${entry.name}`;
      const manifest = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
      return { name: manifest.name, directory, dependencies: manifest.dependencies ?? {}, devDependencies: manifest.devDependencies ?? {} };
    }),
  );
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
  const modules: BoundaryModule[] = workspaces.flatMap(workspace => sourceFiles(resolve(root, workspace.directory, "src"))).map(path => {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const imports: ModuleImport[] = [];
    let performsIO = false;
    let privilegedIngestion = false;
    let ownsTransaction = false;
    function add(specifier: string, typeOnly: boolean): void {
      const target = ts.resolveModuleName(specifier, path, options, ts.sys).resolvedModule?.resolvedFileName;
      imports.push({ specifier, typeOnly, ...(target ? { target: normalize(target) } : {}) });
    }
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        const named = clause?.namedBindings;
        const typeOnly = ts.isExportDeclaration(node)
          ? node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(item => item.isTypeOnly))
          : Boolean(clause && (clause.isTypeOnly || (!clause.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every(item => item.isTypeOnly))));
        add(node.moduleSpecifier.text, typeOnly);
        if (!typeOnly && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.some(item => !item.isTypeOnly && (item.propertyName?.text ?? item.name.text) === "createSeedPool")) {
          privilegedIngestion = true;
        }
      }
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(source);
        if ((node.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text, false);
        if (["fetch", "globalThis.fetch"].includes(name)) performsIO = true;
        if (/(?:^|\.)(?:createSeedPool|resetLedger)$/.test(name)) privilegedIngestion = true;
        if (name === "withTenant" || /(?:^|\.)(?:connect|createAppPool|createSeedPool)$/.test(name)) ownsTransaction = true;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "resetLedger") privilegedIngestion = true;
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Pool") ownsTransaction = true;
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const value = ts.isStringLiteralLike(node) ? node.text : node.getText(source);
        if (/\btesting\./.test(value)) privilegedIngestion = true;
        if (/^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(value)) ownsTransaction = true;
      }
      if (ts.isPropertyAccessExpression(node) && node.getText(source) === "process.env") performsIO = true;
      ts.forEachChild(node, visit);
    }
    visit(source);
    return { path: normalize(path), imports, performsIO, privilegedIngestion, ownsTransaction };
  });
  return { errors: checkModuleBoundaries(modules, workspaces, pureEntrypoints, productionIngestionEntrypoints), moduleCount: modules.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = inspectWorkspaceBoundaries(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  if (result.errors.length) throw new Error(`Module boundaries failed:\n${result.errors.join("\n")}`);
  console.log(`Module boundaries passed: ${result.moduleCount} production modules, declared dependencies, pure entrypoints, no runtime workspace cycles.`);
}
