import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('module-load auto-initialization guards', () => {
  test('auto-installs innertube-interceptor, ui hooks, and trusted-types hook when browser globals are present', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevDocumentCtor = globals.Document;
    const prevJsonParse = JSON.parse;
    const prevRespJson = Response.prototype.json;
    const prevXhrSend = globals.XMLHttpRequest ? XMLHttpRequest.prototype.send : undefined;

    const baseCreateElement = () => ({ nonce: '' }) as unknown as HTMLElement;
    const docListeners = new Map<string, Set<(e: unknown) => void>>();

    globals.Document = { prototype: { createElement: baseCreateElement } };
    globals.window = {
      location: { hash: '#/watch?v=autoInitVid', search: '' },
      fetch: async () => new Response('{}', { status: 200 }),
      addEventListener: () => {},
      removeEventListener: () => {},
      _yttv: { host: { instance: { resolveCommand: () => true } } },
    };
    globals.document = {
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        const set = docListeners.get(type) ?? new Set();
        set.add(fn);
        docListeners.set(type, set);
      },
      removeEventListener: (type: string, fn: (e: unknown) => void) => {
        docListeners.get(type)?.delete(fn);
      },
    };

    t.after(() => {
      JSON.parse = prevJsonParse;
      Response.prototype.json = prevRespJson;
      if (prevXhrSend && globals.XMLHttpRequest) {
        XMLHttpRequest.prototype.send = prevXhrSend;
      }
      if (prevDocumentCtor === undefined) delete globals.Document;
      else globals.Document = prevDocumentCtor;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
    });

    await import('../mods/core/innertube-interceptor.ts');
    await import('../mods/ui/ui.ts');
    await import('../mods/core/trusted-types.ts');

    assert.notEqual(Response.prototype.json, prevRespJson);
    assert.equal(docListeners.get('keydown')?.size, 1);
    assert.equal(docListeners.get('click')?.size, 1);
    assert.notEqual(
      (globals.Document as { prototype: { createElement: unknown } }).prototype.createElement,
      baseCreateElement
    );
  });
});
