import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { injectCss } from '../../mods/core/styles.ts';

describe('injectCss', () => {
  test('handles missing document, unsupported Constructable Stylesheets, and adoptedStyleSheets injection', (t) => {
    const globals = globalThis as { document?: unknown; CSSStyleSheet?: unknown };
    const prevDoc = globals.document;
    const prevCssSheet = globals.CSSStyleSheet;
    t.after(() => {
      if (prevDoc === undefined) delete globals.document;
      else globals.document = prevDoc;
      if (prevCssSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevCssSheet;
    });

    delete globals.document;
    assert.doesNotThrow(() => injectCss('body{}'));

    const adopted: unknown[] = [];
    const appended: unknown[] = [];
    globals.document = {
      adoptedStyleSheets: adopted,
      head: { appendChild: (el: unknown) => appended.push(el) },
      querySelector: () => null,
      createElement: () => ({ textContent: '' }),
    };
    globals.CSSStyleSheet = class {
      replaceSync(): void {
        throw new Error('unsupported');
      }
    };
    assert.doesNotThrow(() => injectCss('body{}'));
    assert.equal(adopted.length, 0);
    assert.equal(appended.length, 0);

    let syncedCss = '';
    globals.CSSStyleSheet = class MockSheet {
      replaceSync(css: string): void {
        syncedCss = css;
      }
    };
    injectCss('.tt-rule{display:none}');
    assert.equal(syncedCss, '.tt-rule{display:none}');
    assert.equal((globals.document as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets.length, 1);
  });

  test('[L1] removes dead trusted-types createElement wrapper and unreachable style-element fallback', () => {
    const modsDir = path.resolve(process.cwd(), 'mods');
    assert.equal(fs.existsSync(path.join(modsDir, 'core', 'trusted-types.ts')), false);
    const indexSrc = fs.readFileSync(path.join(modsDir, 'index.ts'), 'utf8');
    assert.equal(indexSrc.includes('trusted-types'), false);
    assert.equal(injectCss.length, 1);
  });
});
