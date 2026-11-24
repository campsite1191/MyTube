import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');

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

describe('Repository, patch & CI workflow invariants', () => {
  test('[H1] patches/10 keeps AudioTrackAudioSink as default instead of forcing NdkAudioMode::kPullSink', () => {
    const patch10 = fs.readFileSync(path.join(ROOT_DIR, 'patches', '10-media-hdr-aaudio-cache-tuning.patch'), 'utf8');
    assert.equal(patch10.includes('NdkAudioMode::kPullSink'), false);
    assert.equal(patch10.includes('player_components_factory.cc'), false);
  });

  test('[M6] CI workflows pin third-party actions to 40-char SHAs, avoid npx --yes and raw input interpolation, pin retry cobalt_sha, and set monotonic version_code', () => {
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
        if (!ref.startsWith('actions/')) {
          assert.match(ref, /@[0-9a-f]{40}$/, `${file}: third-party action "${ref}" must be pinned to a 40-hex SHA`);
        }
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

  test('[L4] repository keeps single canonical lockfile at mods/package-lock.json', () => {
    assert.equal(fs.existsSync(path.join(ROOT_DIR, 'package-lock.json')), false);
    assert.equal(fs.existsSync(path.join(ROOT_DIR, 'mods', 'package-lock.json')), true);
  });
});
