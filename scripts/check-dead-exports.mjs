import fs from 'node:fs';
import path from 'node:path';

function collectTsFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full);
    }
  }
  return results.sort();
}

const root = process.cwd();
const modFiles = collectTsFiles(path.join(root, 'mods'));
const testFiles = collectTsFiles(path.join(root, 'tests'));
const sources = new Map([...modFiles, ...testFiles].map((f) => [f, fs.readFileSync(f, 'utf8')]));

const EXPORT_DECL_RE = /export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g;

const dead = [];
const allSearchable = [...modFiles, ...testFiles];

for (const file of modFiles) {
  const src = sources.get(file) ?? '';
  const symbols = new Set();

  for (const m of src.matchAll(EXPORT_DECL_RE)) {
    if (m[1]) symbols.add(m[1]);
  }
  for (const m of src.matchAll(EXPORT_LIST_RE)) {
    if (!m[1]) continue;
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (alias) symbols.add(alias);
    }
  }

  for (const sym of symbols) {
    const wordRe = new RegExp(`\\b${sym.replace(/\$/g, '\\$')}\\b`);
    const referenced = allSearchable.some((other) => other !== file && wordRe.test(sources.get(other) ?? ''));
    if (!referenced) {
      dead.push(`${path.relative(root, file)}: ${sym}`);
    }
  }
}

if (dead.length > 0) {
  console.error('Dead exports found (unreferenced outside their defining file):');
  for (const item of dead) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`Checked ${modFiles.length} module file(s); 0 dead exports found.`);
