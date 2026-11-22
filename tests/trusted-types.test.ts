import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { installTrustedTypesNonceHook } from '../mods/core/trusted-types.ts';

describe('trusted-types CSP nonce hook', () => {
  test('returns a safe no-op when Document prototype or createElement is missing', () => {
    const restoreMissing = installTrustedTypesNonceHook(undefined);
    restoreMissing();

    const restoreInvalid = installTrustedTypesNonceHook({} as Pick<Document, 'createElement'>);
    restoreInvalid();
  });

  test('propagates and caches CSP nonce on created style elements and restores cleanly', () => {
    let queryCalls = 0;
    const baseCreateElement = (_tagName: string) => ({ nonce: '' }) as unknown as HTMLElement;
    const proto = { createElement: baseCreateElement };

    const fallbackDoc = {
      querySelector: () => {
        queryCalls++;
        return { nonce: 'nonce-abc' };
      },
    } as unknown as Document;

    const restore = installTrustedTypesNonceHook(proto, fallbackDoc);
    try {
      // Non-5-char tags and 5-char non-style tags skip nonce lookup entirely.
      const divDoc = {
        createElement: proto.createElement,
        querySelector: () => {
          queryCalls++;
          return { nonce: 'should-not-read' };
        },
      };
      const divEl = divDoc.createElement('div');
      const audioEl = divDoc.createElement('audio');
      const numEl = (divDoc.createElement as (t: unknown) => HTMLElement)(12345);
      assert.equal(divEl.nonce, '');
      assert.equal(audioEl.nonce, '');
      assert.equal(numEl.nonce, '');
      assert.equal(queryCalls, 0);

      // Existing nonce on element is left untouched.
      const preNoncedProto = {
        createElement: (_tag: string) => ({ nonce: 'preset' }) as unknown as HTMLElement,
      };
      const restorePre = installTrustedTypesNonceHook(preNoncedProto, fallbackDoc);
      assert.equal(preNoncedProto.createElement('style').nonce, 'preset');
      restorePre();
      assert.equal(queryCalls, 0);

      // First `<style>` queries `this.querySelector` when available and caches nonce.
      const docWithQuery = {
        createElement: proto.createElement,
        querySelector: () => {
          queryCalls++;
          return { nonce: 'doc-nonce-1' };
        },
      };
      const style1 = docWithQuery.createElement('STYLE');
      const style2 = docWithQuery.createElement('style');
      assert.equal(style1.nonce, 'doc-nonce-1');
      assert.equal(style2.nonce, 'doc-nonce-1');
      assert.equal(queryCalls, 1);

      // Fallback document querySelector works when `this` has no querySelector, including empty nonce results.
      const emptyProto = { createElement: baseCreateElement };
      const restoreEmpty = installTrustedTypesNonceHook(emptyProto, {
        querySelector: () => null,
      } as unknown as Document);
      assert.equal(emptyProto.createElement('style').nonce, '');
      restoreEmpty();

      const fallbackProto = { createElement: baseCreateElement };
      const restoreFallback = installTrustedTypesNonceHook(fallbackProto, fallbackDoc);
      assert.equal(fallbackProto.createElement('style').nonce, 'nonce-abc');
      restoreFallback();
    } finally {
      restore();
    }

    assert.equal(proto.createElement, baseCreateElement);
  });
});
