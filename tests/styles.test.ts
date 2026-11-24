import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { injectCss } from '../mods/core/styles.ts';

describe('injectCss', () => {
  test('handles missing document, Constructable Stylesheet disabled fallback, nonce style append, and missing roots', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevDoc = globals.document;
    const prevSheet = globals.CSSStyleSheet;

    t.after(() => {
      if (prevDoc === undefined) delete globals.document;
      else globals.document = prevDoc;
      if (prevSheet === undefined) delete globals.CSSStyleSheet;
      else globals.CSSStyleSheet = prevSheet;
    });

    // No document -> no-op.
    delete globals.document;
    assert.doesNotThrow(() => injectCss('body{}'));

    // Failing CSSStyleSheet with allowStyleElementFallback = false returns early.
    globals.CSSStyleSheet = class {
      replaceSync(): void {
        throw new Error('Blocked');
      }
    };
    globals.document = { head: null, documentElement: null };
    assert.doesNotThrow(() => injectCss('body{}', false));

    // Missing head and documentElement with fallback enabled exits cleanly.
    assert.doesNotThrow(() => injectCss('body{}', true));

    // Reuses existing style[nonce] when present (including nullish textContent).
    const existingStyle = { textContent: null as string | null };
    globals.document = {
      head: null,
      documentElement: { appendChild: () => {} },
      querySelector: (sel: string) => (sel === 'style[nonce]' ? existingStyle : null),
    };
    injectCss('.rule1{}', true);
    assert.equal(existingStyle.textContent, '.rule1{}');
  });

  test('[TDD Red: L1] removes dead trusted-types createElement wrapper and unreachable style-element fallback', () => {
    const modsDir = path.resolve(import.meta.dirname, '..', 'mods');
    assert.equal(fs.existsSync(path.join(modsDir, 'core', 'trusted-types.ts')), false);
    const indexSrc = fs.readFileSync(path.join(modsDir, 'index.ts'), 'utf8');
    assert.equal(indexSrc.includes('trusted-types'), false);
    assert.equal(injectCss.length, 1);
  });
});
