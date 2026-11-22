import assert from 'node:assert/strict';
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
});
