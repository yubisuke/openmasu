import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";
import * as publicCore from "./evaluator.js";
import { TimestampInvalidError, time } from "./evaluation-utils.js";
import {
  FixtureArrayCandidateProvider, IndexedCandidateProvider,
  createFixtureCandidateProvider, createIndexedCandidateProvider,
} from "./candidates.js";
import type { Json, CandidateAttempt, CandidateHistoryState, CandidateProvider, CandidateProviderFactory, ScopedCost } from "./evaluator.js";

// Compile-time compatibility: these types still come from the public evaluator entrypoint.
type PublicContract = [Json, CandidateAttempt, CandidateHistoryState, CandidateProvider, CandidateProviderFactory, ScopedCost];
const compatibility: PublicContract | undefined = undefined;
void compatibility;

describe("evaluator module boundaries", () => {
  it("preserves the public runtime exports and constructor identities", () => {
    assert.deepEqual(Object.keys(publicCore).sort(), [
      "FixtureArrayCandidateProvider", "IndexedCandidateProvider", "TimestampInvalidError",
      "compareCandidateAttempts", "createFixtureCandidateProvider", "createIndexedCandidateProvider",
      "evaluate", "jcs", "roundHalfEven", "selectDisjointCosts", "sha256", "sortCandidateAttempts",
    ].sort());
    assert.equal(publicCore.TimestampInvalidError, TimestampInvalidError);
    assert.equal(publicCore.FixtureArrayCandidateProvider, FixtureArrayCandidateProvider);
    assert.equal(publicCore.IndexedCandidateProvider, IndexedCandidateProvider);
    assert.equal(publicCore.createFixtureCandidateProvider, createFixtureCandidateProvider);
    assert.equal(publicCore.createIndexedCandidateProvider, createIndexedCandidateProvider);
    assert.throws(() => time("invalid", "received_at"), publicCore.TimestampInvalidError);
  });

  it("keeps calculation modules acyclic and free of runtime IO and implicit clocks", () => {
    const directory = new URL(".", import.meta.url);
    const graph = new Map<string, string[]>();
    for (const name of readdirSync(directory).filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const source = ts.createSourceFile(name, readFileSync(new URL(name, directory), "utf8"), ts.ScriptTarget.Latest, true);
      const edges: string[] = [];
      function visit(node: ts.Node): void {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const named = clause?.namedBindings;
          const typeOnly = ts.isExportDeclaration(node)
            ? node.isTypeOnly || Boolean(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length && node.exportClause.elements.every(item => item.isTypeOnly))
            : Boolean(clause && (clause.isTypeOnly || (!clause.name && named && ts.isNamedImports(named) && named.elements.length && named.elements.every(item => item.isTypeOnly))));
          if (!typeOnly) {
            const specifier = node.moduleSpecifier.text;
            assert.ok(!/^(?:pg(?:\/|$)|node:(?:fs|http|https|net|dns|child_process|worker_threads)(?:\/|$)|@openmasu\/(?:api|worker|runtime|redirector)(?:\/|$))/.test(specifier), `${name}: ${specifier}`);
            if (specifier.startsWith(".")) edges.push(basename(specifier).replace(/\.js$/, ".ts"));
          }
        }
        if (ts.isCallExpression(node)) {
          assert.ok(!["Date.now", "Math.random", "fetch", "globalThis.fetch", "require"].includes(node.expression.getText(source)), name);
          assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword, name);
        }
        if (ts.isNewExpression(node) && node.expression.getText(source) === "Date") assert.ok(node.arguments?.length, name);
        if (ts.isPropertyAccessExpression(node)) assert.notEqual(node.getText(source), "process.env", name);
        ts.forEachChild(node, visit);
      }
      visit(source);
      graph.set(name, edges);
    }
    const complete = new Set<string>();
    function visit(name: string, chain: readonly string[]): void {
      assert.ok(!chain.includes(name), `calculation cycle: ${[...chain, name].join(" -> ")}`);
      if (complete.has(name)) return;
      assert.ok(graph.has(name), `missing calculation module: ${name}`);
      for (const next of graph.get(name)!) visit(next, [...chain, name]);
      complete.add(name);
    }
    for (const name of graph.keys()) visit(name, []);
  });
});
