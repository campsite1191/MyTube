import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { discoverRuntimeModFiles, verifyCoverageSummary } from '../helpers/coverage-verifier.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

function extractRunBlocks(yamlContent: string): Array<{ line: number; body: string }> {
  const lines = yamlContent.split('\n');
  const blocks: Array<{ line: number; body: string }> = [];
  let i = 0;

  while (i < lines.length) {
    const lineText = lines[i] ?? '';
    const match = lineText.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const baseIndent = match[1]?.length ?? 0;
    const inlineValue = (match[2] ?? '').trim();
    if (inlineValue !== '|' && inlineValue !== '>') {
      blocks.push({ line: i + 1, body: inlineValue });
      i++;
      continue;
    }

    const bodyLines: string[] = [];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      if (next.trim() === '') {
        bodyLines.push('');
        i++;
        continue;
      }
      const nextIndent = next.search(/\S/);
      if (nextIndent <= baseIndent) break;
      bodyLines.push(next);
      i++;
    }
    blocks.push({ line: i + 1, body: bodyLines.join('\n') });
  }

  return blocks;
}

const MOD_SUBDIRS = ['core', 'features', 'transforms', 'ui', 'utils'] as const;
const MAX_MOD_FILE_LINES = 500;

function collectModTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectModTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

function isRuntimeSpecifierClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith('type ') || trimmed.startsWith('type{')) return false;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return false;
    const parts = inner
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.some((part) => !part.startsWith('type '));
  }
  return true;
}

function extractRelativeImports(source: string): Array<{ specifier: string; isRuntime: boolean }> {
  const imports: Array<{ specifier: string; isRuntime: boolean }> = [];
  const stmtRe = /^[ \t]*(?:(import|export)\s+([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"])/gm;
  for (const match of source.matchAll(stmtRe)) {
    if (match[4]) {
      imports.push({ specifier: match[4], isRuntime: true });
      continue;
    }
    const clause = match[2] ?? '';
    const specifier = match[3] ?? '';
    imports.push({ specifier, isRuntime: isRuntimeSpecifierClause(clause) });
  }
  return imports;
}

function findRuntimeCycles(nodes: readonly string[], adjacency: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const strongConnect = (v: string): void => {
    const vIdx = index++;
    indices.set(v, vIdx);
    lowlinks.set(v, vIdx);
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        const vLow = lowlinks.get(v) ?? 0;
        const wLow = lowlinks.get(w) ?? 0;
        if (wLow < vLow) lowlinks.set(v, wLow);
      } else if (onStack.has(w)) {
        const vLow = lowlinks.get(v) ?? 0;
        const wIdx = indices.get(w) ?? 0;
        if (wIdx < vLow) lowlinks.set(v, wIdx);
      }
    }

    if ((lowlinks.get(v) ?? 0) === vIdx) {
      const scc: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member !== undefined) {
          onStack.delete(member);
          scc.push(member);
        }
      } while (member !== undefined && member !== v);

      if (scc.length > 1 || (scc.length === 1 && adjacency.get(v)?.has(v))) {
        cycles.push(scc);
      }
    }
  };

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return cycles;
}

describe('Repository, patch & CI workflow invariants', () => {
  test('[H1] patches/10 keeps AudioTrackAudioSink as default instead of forcing NdkAudioMode::kPullSink', () => {
    const patch10 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '10-media-hdr-aaudio-cache-tuning.patch'), 'utf8');
    assert.equal(patch10.includes('NdkAudioMode::kPullSink'), false);
    assert.equal(patch10.includes('player_components_factory.cc'), false);
  });

  test('[P10] patches/10 avoids force-enabling foreground MemoryCache eviction and patches/11 keeps enable_feature_if_set', () => {
    const patch10 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '10-media-hdr-aaudio-cache-tuning.patch'), 'utf8');
    const patch11 = fs.readFileSync(
      path.join(ROOT_DIR, 'patches', '11-manifest-hardening-and-mojo-sizing.patch'),
      'utf8'
    );
    assert.equal(patch10.includes('+  AppendSwitchIfAbsent('), false);
    assert.equal(patch10.includes('switches::kAllowCriticalMemoryPressureHandlingInForeground'), true);
    assert.equal(patch10.includes('kEvictMemoryCacheOnCriticalMemoryPressure'), false);
    assert.equal(patch10.includes('kCobaltEnableModerateMemoryPressure'), false);
    assert.equal(patch11.includes('-  auto enable_feature_if_set'), false);
  });

  test('[M6] CI workflows use unpinned version/branch action refs, avoid npx --yes and raw input interpolation, pin retry cobalt_sha, and set monotonic version_code', () => {
    const workflowsDir = path.join(ROOT_DIR, '.github', 'workflows');
    const workflowFiles = fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml'))
      .sort();

    for (const file of workflowFiles) {
      const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');

      const usesMatches = content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm);
      for (const m of usesMatches) {
        const ref = m[1] ?? '';
        assert.doesNotMatch(
          ref,
          /@[0-9a-f]{40}$/i,
          `${file}: action "${ref}" must use latest version tag/branch instead of pinning a commit SHA`
        );
      }

      assert.equal(content.includes('npx --yes'), false, `${file} must not run unpinned npx --yes`);

      for (const block of extractRunBlocks(content)) {
        assert.doesNotMatch(
          block.body,
          /\$\{\{\s*inputs\./,
          `${file} line ${block.line}: must bind workflow inputs via env: instead of interpolating into run:`
        );
      }
    }

    const buildApkYml = fs.readFileSync(path.join(workflowsDir, 'build_apk.yml'), 'utf8');
    const retrySectionMatch = buildApkYml.match(/gh workflow run build_apk\.yml[\s\S]{0,400}/);
    assert.ok(retrySectionMatch, 'Expected Auto-Retry gh workflow run invocation in build_apk.yml');
    assert.match(retrySectionMatch[0], /-f\s+cobalt_sha=/, 'Auto-retry must pin cobalt_sha across retry attempts');

    const patch01 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '01-gn-arm-cortex-a73-and-trim.patch'), 'utf8');
    const hotswapYml = fs.readFileSync(path.join(workflowsDir, 'hotswap_js.yml'), 'utf8');
    const hasStaticVersionCodeOnly =
      patch01.includes('version_code = "1"') &&
      !buildApkYml.includes('version_code') &&
      !hotswapYml.includes('version_code');
    assert.equal(hasStaticVersionCodeOnly, false, 'APK builds must not ship a static version_code = "1"');
  });

  test('[L2] patches/04 caches UTF-16 userscript directly without duplicate UTF-8 heap buffer', () => {
    const patch04 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '04-bundle-local-userscript.patch'), 'utf8');
    assert.equal(patch04.includes('base::NoDestructor<std::u16string>'), true);
    assert.equal(patch04.includes('base::NoDestructor<std::string>'), false);
  });

  test('[L3] patches/09 verifies signature before super.onCreate and patches/12 calls super.onNewIntent', () => {
    const patch09 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '09-integrity-check.patch'), 'utf8');
    const onCreateSlice = patch09.slice(patch09.indexOf('protected void onCreate(Bundle savedInstanceState)'));
    const verifyPos = onCreateSlice.indexOf('verifyApkSignature()');
    const superOnCreatePos = onCreateSlice.indexOf('super.onCreate(savedInstanceState)');
    assert.ok(verifyPos !== -1 && superOnCreatePos !== -1 && verifyPos < superOnCreatePos);

    const patch12 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '12-deeplink-url-allowlist.patch'), 'utf8');
    assert.equal(patch12.includes('super.onNewIntent(intent)'), true);
  });

  test('[L4] repository does not track package-lock.json and workflows install with --no-package-lock', () => {
    assert.equal(fs.existsSync(path.join(ROOT_DIR, 'package-lock.json')), false);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, 'mods', 'package-lock.json')), false);
    const gitignore = fs.readFileSync(path.join(ROOT_DIR, '.gitignore'), 'utf8');
    assert.equal(gitignore.includes('package-lock.json'), true);

    const workflowsDir = path.join(ROOT_DIR, '.github', 'workflows');
    for (const wf of ['lint_js.yml', 'build_apk.yml', 'hotswap_js.yml']) {
      const yml = fs.readFileSync(path.join(workflowsDir, wf), 'utf8');
      assert.equal(yml.includes('npm --prefix') && yml.includes(' ci '), false, `${wf} should not use npm ci`);
      assert.equal(yml.includes('--no-package-lock'), true, `${wf} must pass --no-package-lock`);
    }

    const patch06 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '06-java-switches-tuning.patch'), 'utf8');
    assert.equal(patch06.includes('-      {::switches::kEnableBlinkFeatures, "PreciseMemoryInfo"},'), true);

    const keepAliveYml = fs.readFileSync(path.join(workflowsDir, 'keep_ccache_alive.yml'), 'utf8');
    assert.equal(keepAliveYml.includes("cron: '17 3 */3 * *'"), true);
  });

  test('[P15] patches/15 strips telemetry/crashpad/bloat while keeping metrics JNI and CI anchors', () => {
    const patch15 = fs.readFileSync(
      path.join(ROOT_DIR, 'patches', '15-strip-telemetry-crashpad-and-apk-bloat.patch'),
      'utf8'
    );
    const lintPatchesYml = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'lint_patches.yml'), 'utf8');

    for (const token of [
      'libchrome_crashpad_handler.so',
      'google_play_services_ads_identifier_java',
      'google_play_services_basement_java',
      'CobaltPictureInPictureActivity',
      'ChildProcessLauncherTestHelperService',
      'https://youtube.com/tv/uma',
      'starboard/android/shared/BUILD.gn',
      'crash_annotator_jni.cc',
      'shell_browser_main_parts.cc',
      'ChildExitObserver',
      'ChildProcessCrashObserver',
    ]) {
      assert.equal(patch15.includes(token), true, `Missing expected patch 15 strip target: ${token}`);
    }

    // Must keep //components/metrics:metrics_java for LowEntropySource JNI and avoid deleting CI anchors.
    assert.equal(patch15.includes('-    "//components/metrics:metrics_java",'), false);
    assert.equal(patch15.includes('-  version_code = "1"'), false);
    assert.equal(patch15.includes('-  version_name = "1.0.0"'), false);

    assert.equal(lintPatchesYml.includes('NUM_SANDBOXED_SERVICES'), true);
    assert.equal(lintPatchesYml.includes('NUM_PRIVILEGED_SERVICES'), true);
    assert.equal(lintPatchesYml.includes('CobaltPictureInPictureActivity'), true);
    assert.equal(lintPatchesYml.includes('zygotePreloadName'), true);
    assert.equal(lintPatchesYml.includes('crash_annotator_jni.cc'), true);
    assert.equal(lintPatchesYml.includes('ChildExitObserver'), true);
  });

  test('mirrors every runtime module under mods/ 1:1 with tests/ bidirectionally', () => {
    const modsDir = path.join(ROOT_DIR, 'mods');
    const testsDir = path.join(ROOT_DIR, 'tests');
    assert.equal(fs.existsSync(path.join(modsDir, 'index.ts')), true, 'Missing mods/index.ts');
    assert.equal(fs.existsSync(path.join(testsDir, 'index.test.ts')), true, 'Missing tests/index.test.ts');

    const rootTestFiles = fs
      .readdirSync(testsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(rootTestFiles, ['index.test.ts']);

    for (const subdir of MOD_SUBDIRS) {
      const modFiles = fs
        .readdirSync(path.join(modsDir, subdir))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
        .sort();
      const testFiles = fs
        .readdirSync(path.join(testsDir, subdir))
        .filter((f) => f.endsWith('.test.ts'))
        .sort();

      for (const file of modFiles) {
        const expectedTest = path.join(testsDir, subdir, `${path.basename(file, '.ts')}.test.ts`);
        assert.equal(fs.existsSync(expectedTest), true, `Missing 1:1 test file: ${expectedTest}`);
      }
      for (const testFile of testFiles) {
        const baseName = testFile.slice(0, -'.test.ts'.length);
        const expectedMod = path.join(modsDir, subdir, `${baseName}.ts`);
        assert.equal(fs.existsSync(expectedMod), true, `Orphaned unit test without runtime module: ${testFile}`);
      }
    }
  });

  test('enforces <= 500 lines per file, zero runtime import cycles, and strict utils/core layer boundaries in mods/', () => {
    const modsDir = path.join(ROOT_DIR, 'mods');
    const allModFiles = collectModTsFiles(modsDir);
    const runtimeFiles = allModFiles.filter(
      (filePath) => !filePath.endsWith('.d.ts') && !path.relative(modsDir, filePath).startsWith(`types${path.sep}`)
    );
    const runtimeSet = new Set(runtimeFiles);
    const adjacency = new Map<string, Set<string>>();

    for (const filePath of allModFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lineCount = content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
      const relPath = path.relative(ROOT_DIR, filePath);
      assert.ok(
        lineCount <= MAX_MOD_FILE_LINES,
        `${relPath} has ${lineCount} lines, exceeding max ${MAX_MOD_FILE_LINES}`
      );

      if (!runtimeSet.has(filePath)) continue;

      const relFromMods = path.relative(modsDir, filePath).split(path.sep).join('/');
      const sourceLayer = relFromMods.split('/')[0] ?? '';
      const edges = new Set<string>();
      adjacency.set(filePath, edges);

      for (const { specifier, isRuntime } of extractRelativeImports(content)) {
        const resolved = path.resolve(path.dirname(filePath), specifier);
        if (isRuntime && runtimeSet.has(resolved)) {
          edges.add(resolved);
        }

        const targetRel = path.relative(modsDir, resolved).split(path.sep).join('/');
        const targetLayer = targetRel.split('/')[0] ?? '';
        if (sourceLayer === 'utils') {
          assert.ok(
            targetLayer === 'utils' || targetLayer === 'types',
            `Layer violation in ${relPath}: utils may only import utils or types (found ${specifier})`
          );
        } else if (sourceLayer === 'core') {
          assert.ok(
            targetLayer === 'core' || targetLayer === 'utils' || targetLayer === 'types',
            `Layer violation in ${relPath}: core may only import core, utils, or types (found ${specifier})`
          );
        }
      }
    }

    const cycles = findRuntimeCycles(runtimeFiles, adjacency).map((cycle) =>
      cycle.map((filePath) => path.relative(ROOT_DIR, filePath))
    );
    assert.deepEqual(cycles, [], `Detected runtime import cycle(s): ${JSON.stringify(cycles)}`);
  });

  test('coverage verifier enforces 100% line, branch, function coverage and runtime file completeness, and is wired into lint and CI', () => {
    const runtimeFiles = discoverRuntimeModFiles(ROOT_DIR);
    assert.ok(runtimeFiles.includes('mods/index.ts'));
    assert.equal(
      runtimeFiles.some(
        (f) => f.includes('node_modules/') || f.includes('/dist/') || f.includes('/types/') || f.endsWith('.d.ts')
      ),
      false
    );

    assert.equal(verifyCoverageSummary([], []).length, 1);

    const completeSummary = [
      {
        path: path.join(ROOT_DIR, 'mods', 'index.ts'),
        totalLineCount: 10,
        coveredLineCount: 10,
        totalBranchCount: 4,
        coveredBranchCount: 4,
        totalFunctionCount: 2,
        coveredFunctionCount: 2,
      },
    ];
    assert.deepEqual(verifyCoverageSummary(completeSummary, ['mods/index.ts'], ROOT_DIR), []);

    const missingFileErrors = verifyCoverageSummary(
      completeSummary,
      ['mods/index.ts', 'mods/core/missing.ts'],
      ROOT_DIR
    );
    assert.match(missingFileErrors[0] ?? '', /Missing coverage report.*mods\/core\/missing\.ts/);

    const partialErrors = verifyCoverageSummary(
      [
        {
          path: 'mods/index.ts',
          totalLineCount: 10,
          coveredLineCount: 9,
          totalBranchCount: 4,
          coveredBranchCount: 3,
          totalFunctionCount: 2,
          coveredFunctionCount: 1,
          lines: [{ line: 5, count: 0 }],
          branches: [{ line: 6, count: 0 }],
          functions: [{ name: 'boot', line: 2, count: 0 }],
        },
      ],
      ['mods/index.ts'],
      ROOT_DIR
    );
    assert.equal(partialErrors.length, 3);
    assert.match(partialErrors[0] ?? '', /line coverage 9\/10.*lines: 5/);
    assert.match(partialErrors[1] ?? '', /branch coverage 3\/4.*lines: 6/);
    assert.match(partialErrors[2] ?? '', /function coverage 1\/2.*boot@2/);

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    assert.ok(pkg.scripts?.['lint:coverage'], 'package.json must define lint:coverage');
    assert.ok(pkg.scripts?.lint?.includes('lint:coverage'), 'package.json lint script must invoke lint:coverage');

    for (const wf of ['lint_js.yml', 'build_apk.yml', 'hotswap_js.yml']) {
      const yml = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', wf), 'utf8');
      assert.ok(yml.includes('npm run lint:coverage'), `${wf} must enforce npm run lint:coverage`);
    }
  });
});
