#!/usr/bin/env tsx
/**
 * scripts/crap-score.ts — Cyclomatic-complexity scan for the monorepo.
 *
 * Adapted from CCSC's `scripts/crap-score.ts` (same author, same TS AST
 * walker). Walks every production source file under `packages/* /src` and
 * `apps/* /src`, computes McCabe cyclomatic complexity per function, and
 * fails if any function exceeds the threshold.
 *
 * Why this instead of the harness `crap-score.py`: the upstream Python
 * script depends on the unmaintained `complexity-report` JS tool, which
 * cannot parse modern TS (async, optional chaining, satisfies, etc.).
 * This file uses the TypeScript compiler API directly (already a devDep)
 * to count decision points properly.
 *
 * Cyclomatic complexity formula (classic McCabe): 1 + count of decision
 * nodes. Counted nodes (per function body):
 *   - IfStatement (including else-if chains — each else-if is its own IfStatement)
 *   - WhileStatement, DoStatement, ForStatement, ForInStatement, ForOfStatement
 *   - CaseClause (not DefaultClause)
 *   - CatchClause
 *   - ConditionalExpression (`?:`)
 *   - BinaryExpression with &&, ||, ?? (short-circuit introduces a branch)
 *
 * Wall 5 (production) threshold: 30 (per tests/TESTING.md `crap.prod`).
 * Test files are excluded (Wall 6 / test threshold tracked separately).
 *
 * CRAP score proper is `cyclomatic^2 * (1 - coverage)^3 + cyclomatic`.
 * With repo coverage at ~87%, the first term contributes ~0.2% of the
 * total at complexity 30. This script reports raw cyclomatic complexity
 * (a tight upper bound on CRAP) for predictability and zero coupling to
 * coverage report shape. If coverage drops materially we can wire the
 * full CRAP formula via lcov parsing.
 *
 * Usage:
 *   pnpm crap                       # uses default threshold 30
 *   pnpm crap -- --threshold 25     # override
 *
 * Exit codes:
 *   0 — all functions under threshold
 *   1 — one or more functions exceed the threshold
 *   2 — CLI / parse error
 *
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// Aligned with tests/TESTING.md §Thresholds `crap.prod`. Tightened 40 → 30
// (Wall 5 ideal) once apps/edge-daemon runCycle was refactored from
// cyclomatic 36 to a thin coordinator over named per-step helpers (bead
// qmd-team-intent-kb-igs). Current repo-wide max is well under 30.
const DEFAULT_THRESHOLD = 30;
const REPO_ROOT = process.cwd();

const SOURCE_ROOTS = ['packages', 'apps'];

const EXCLUDE_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /(^|\/)\.stryker-tmp\//,
  /(^|\/)__tests__\//,
  /(^|\/)test-fixtures\//,
  /\.test\.ts$/,
  /\.d\.ts$/,
];

interface FunctionMetric {
  name: string;
  line: number;
  complexity: number;
}

interface FileReport {
  path: string;
  functions: FunctionMetric[];
  max: number;
  mean: number;
  overThreshold: FunctionMetric[];
}

interface PackageReport {
  name: string;
  files: FileReport[];
  funcCount: number;
  max: number;
  mean: number;
  overCount: number;
}

function isExcluded(path: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(path));
}

function walkSources(root: string): string[] {
  const results: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(REPO_ROOT, full);
      if (isExcluded(rel)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        results.push(full);
      }
    }
  }
  return results;
}

function functionName(node: ts.Node, source: ts.SourceFile): string {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isFunctionExpression(node)
  ) {
    if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && node.parent) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
  }
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `<anon:${line + 1}>`;
}

function countComplexity(node: ts.Node): number {
  let complexity = 1;
  const visit = (n: ts.Node): void => {
    if (
      n !== node &&
      (ts.isFunctionDeclaration(n) ||
        ts.isFunctionExpression(n) ||
        ts.isArrowFunction(n) ||
        ts.isMethodDeclaration(n) ||
        ts.isConstructorDeclaration(n))
    ) {
      return;
    }
    switch (n.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        complexity++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const be = n as ts.BinaryExpression;
        if (
          be.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          be.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          be.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          complexity++;
        }
        break;
      }
    }
    n.forEachChild(visit);
  };
  node.forEachChild(visit);
  return complexity;
}

function analyseFile(absolutePath: string): FileReport {
  const displayName = relative(REPO_ROOT, absolutePath);
  const source = ts.createSourceFile(
    displayName,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const metrics: FunctionMetric[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      metrics.push({
        name: functionName(node, source),
        line: line + 1,
        complexity: countComplexity(node),
      });
    }
    node.forEachChild(walk);
  };
  walk(source);
  const complexities = metrics.map((m) => m.complexity);
  const max = complexities.length ? Math.max(...complexities) : 0;
  const mean = complexities.length
    ? complexities.reduce((s, c) => s + c, 0) / complexities.length
    : 0;
  return { path: displayName, functions: metrics, max, mean, overThreshold: [] };
}

function packageNameFromPath(p: string): string {
  // packages/policy-engine/src/foo.ts -> packages/policy-engine
  // apps/api/src/routes/foo.ts        -> apps/api
  const parts = p.split('/');
  return parts.slice(0, 2).join('/');
}

function main(): number {
  const argv = process.argv.slice(2);
  let threshold = DEFAULT_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--threshold' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`crap-score: invalid threshold: ${argv[i + 1]}`);
        return 2;
      }
      threshold = n;
      i++;
    } else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('Usage: pnpm crap [-- --threshold N]');
      return 0;
    } else {
      console.error(`crap-score: unknown flag: ${argv[i]}`);
      return 2;
    }
  }

  const allFiles: string[] = [];
  for (const root of SOURCE_ROOTS) {
    allFiles.push(...walkSources(join(REPO_ROOT, root)));
  }

  if (!allFiles.length) {
    console.error('crap-score: no source files found under packages/ or apps/');
    return 2;
  }

  const fileReports: FileReport[] = [];
  for (const f of allFiles) {
    try {
      const r = analyseFile(f);
      r.overThreshold = r.functions.filter((m) => m.complexity > threshold);
      fileReports.push(r);
    } catch (err) {
      console.error(`crap-score: failed to parse ${f}:`, err);
      return 2;
    }
  }

  // Group by package
  const packagesMap = new Map<string, PackageReport>();
  for (const fr of fileReports) {
    const pkg = packageNameFromPath(fr.path);
    let pr = packagesMap.get(pkg);
    if (!pr) {
      pr = { name: pkg, files: [], funcCount: 0, max: 0, mean: 0, overCount: 0 };
      packagesMap.set(pkg, pr);
    }
    pr.files.push(fr);
    pr.funcCount += fr.functions.length;
    if (fr.max > pr.max) pr.max = fr.max;
    pr.overCount += fr.overThreshold.length;
  }
  for (const pr of packagesMap.values()) {
    const allMetrics = pr.files.flatMap((f) => f.functions.map((m) => m.complexity));
    pr.mean = allMetrics.length ? allMetrics.reduce((s, c) => s + c, 0) / allMetrics.length : 0;
  }

  console.log(`crap-score: cyclomatic complexity scan (threshold ${threshold})`);
  console.log('─'.repeat(78));
  const pad = (s: string | number, w: number): string => String(s).padStart(w);
  const padEnd = (s: string, w: number): string => s.padEnd(w);

  let overallMax = 0;
  let overallOver = 0;
  let overallFuncs = 0;
  const sortedPkgs = [...packagesMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const pr of sortedPkgs) {
    console.log(
      `  ${padEnd(pr.name, 36)}: ${pad(pr.funcCount, 4)} funcs · ` +
        `max=${pad(pr.max, 3)} · ` +
        `mean=${pad(pr.mean.toFixed(1), 5)} · ` +
        `over=${pad(pr.overCount, 2)}`,
    );
    if (pr.max > overallMax) overallMax = pr.max;
    overallOver += pr.overCount;
    overallFuncs += pr.funcCount;
  }
  console.log('─'.repeat(78));
  console.log(
    `  overall: ${overallFuncs} funcs · max=${overallMax} · ` +
      `${overallOver} function(s) over the ${threshold}-threshold`,
  );

  if (overallOver > 0) {
    console.log('');
    console.log('Functions over threshold:');
    for (const pr of sortedPkgs) {
      for (const fr of pr.files) {
        for (const fn of fr.overThreshold) {
          console.log(`  ${fr.path}:${fn.line} ${fn.name} (${fn.complexity})`);
        }
      }
    }
    return 1;
  }
  console.log('crap-score: OK');
  return 0;
}

process.exit(main());
