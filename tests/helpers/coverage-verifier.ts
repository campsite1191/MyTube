import fs from 'node:fs';
import path from 'node:path';

export interface CoverageLineEntry {
  line: number;
  count: number;
}

export interface CoverageBranchEntry {
  line: number;
  count: number;
}

export interface CoverageFunctionEntry {
  name?: string;
  line: number;
  count: number;
}

export interface CoverageFileSummary {
  path: string;
  totalLineCount: number;
  coveredLineCount: number;
  totalBranchCount: number;
  coveredBranchCount: number;
  totalFunctionCount: number;
  coveredFunctionCount: number;
  lines?: readonly CoverageLineEntry[];
  branches?: readonly CoverageBranchEntry[];
  functions?: readonly CoverageFunctionEntry[];
}

interface CoverageEvent {
  type: string;
  data?: {
    summary?: {
      files?: readonly CoverageFileSummary[];
    };
  };
}

const EXCLUDED_MODS_DIRS = new Set(['node_modules', 'dist', 'types']);
const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

function normalizeRepoPath(filePath: string, rootDir: string): string {
  const rel = path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath;
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

/**
 * Discovers all runtime TypeScript source files under `mods/` (excluding dependencies, build output, and types).
 */
export function discoverRuntimeModFiles(rootDir = ROOT_DIR): string[] {
  const modsDir = path.join(rootDir, 'mods');
  const results: string[] = [];

  const walk = (dir: string, isModsRoot: boolean): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isModsRoot && EXCLUDED_MODS_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), false);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        results.push(normalizeRepoPath(path.join(dir, entry.name), rootDir));
      }
    }
  };

  walk(modsDir, true);
  return results.toSorted();
}

/**
 * Verifies every runtime module is present in the coverage summary and has 100% line, branch, and function counts.
 */
export function verifyCoverageSummary(
  files: readonly CoverageFileSummary[],
  runtimeFiles: readonly string[],
  rootDir = ROOT_DIR
): string[] {
  if (runtimeFiles.length === 0) {
    return ['No runtime mods/**/*.ts files discovered for coverage verification.'];
  }

  const filesByPath = new Map<string, CoverageFileSummary>();
  for (const file of files) {
    filesByPath.set(normalizeRepoPath(file.path, rootDir), file);
  }

  const failures: string[] = [];
  for (const runtimeFile of runtimeFiles) {
    const entry = filesByPath.get(normalizeRepoPath(runtimeFile, rootDir));
    if (!entry) {
      failures.push(`Missing coverage report for runtime file: ${runtimeFile}`);
      continue;
    }
    if (entry.coveredLineCount !== entry.totalLineCount) {
      const uncoveredLines = (entry.lines ?? []).filter((l) => l.count === 0).map((l) => l.line);
      const detail = uncoveredLines.length > 0 ? ` (lines: ${uncoveredLines.join(', ')})` : '';
      failures.push(`${runtimeFile}: line coverage ${entry.coveredLineCount}/${entry.totalLineCount} (<100%)${detail}`);
    }
    if (entry.coveredBranchCount !== entry.totalBranchCount) {
      const uncoveredBranches = (entry.branches ?? []).filter((b) => b.count === 0).map((b) => b.line);
      const detail = uncoveredBranches.length > 0 ? ` (lines: ${uncoveredBranches.join(', ')})` : '';
      failures.push(
        `${runtimeFile}: branch coverage ${entry.coveredBranchCount}/${entry.totalBranchCount} (<100%)${detail}`
      );
    }
    if (entry.coveredFunctionCount !== entry.totalFunctionCount) {
      const uncoveredFuncs = (entry.functions ?? [])
        .filter((f) => f.count === 0)
        .map((f) => `${f.name || '<anon>'}@${f.line}`);
      const detail = uncoveredFuncs.length > 0 ? ` (funcs: ${uncoveredFuncs.join(', ')})` : '';
      failures.push(
        `${runtimeFile}: function coverage ${entry.coveredFunctionCount}/${entry.totalFunctionCount} (<100%)${detail}`
      );
    }
  }

  return failures;
}

/**
 * Custom Node test reporter enforcing 100% line, branch, and function coverage across every runtime `mods/*.ts` file.
 */
export default async function* coverageVerifierReporter(source: AsyncIterable<CoverageEvent>): AsyncGenerator<string> {
  let sawCoverage = false;
  const runtimeFiles = discoverRuntimeModFiles(ROOT_DIR);
  const failures: string[] = [];

  for await (const event of source) {
    if (event.type === 'test:coverage') {
      sawCoverage = true;
      const summaryFiles = event.data?.summary?.files ?? [];
      failures.push(...verifyCoverageSummary(summaryFiles, runtimeFiles, ROOT_DIR));
    }
  }

  if (!sawCoverage) {
    failures.push('No test:coverage event received; run Node test runner with --experimental-test-coverage.');
  }

  if (failures.length > 0) {
    process.exitCode = 1;
    yield `\nCoverage verifier FAILED (${failures.length} issue(s)):\n${failures.map((f) => `  - ${f}\n`).join('')}`;
    return;
  }

  yield `\nCoverage verifier PASSED: ${runtimeFiles.length}/${runtimeFiles.length} runtime mods/**/*.ts files at 100% lines, branches, and functions.\n`;
}
