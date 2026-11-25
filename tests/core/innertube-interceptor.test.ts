import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  installInnertubeInterceptor,
  patchPlaybackContextBody,
  syncYttvPreviewAndJson,
} from '../../mods/core/innertube-interceptor.ts';

describe('innertube-interceptor hooks', () => {
  test('installInnertubeInterceptor wraps JSON.parse, Response.json, fetch, XHR, and _yttv runtime cleanly', async (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevDocument = globals.document;
    const prevXhr = globals.XMLHttpRequest;
    const prevJsonParse = JSON.parse;
    const prevResponseJson = Response.prototype.json;

    const sentFetchRequests: Array<{ url: string; body?: string }> = [];
    const sentXhrBodies: unknown[] = [];
    const transformedInputs: unknown[] = [];

    class MockXhr {
      send(body?: unknown): void {
        sentXhrBodies.push(body);
      }
    }

    // Mimic native V8 Response.prototype.json (which does not go through window.JSON.parse).
    Response.prototype.json = async function (this: Response) {
      return prevJsonParse(await this.text());
    };

    const flagsMap = new Map<string, unknown>([['ENABLE_PREVIEWS_WITH_SOUND', false]]);
    const yttvParse = (s: string) => prevJsonParse(s);
    const fakeWindow: Record<string, unknown> = {
      fetch: async (resource: unknown, init?: { body?: string }) => {
        sentFetchRequests.push({ url: String(resource), body: init?.body });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      _yttv: {
        flags: flagsMap,
        jsonMod: { JSON: { parse: yttvParse } },
        host: { instance: { resolveCommand: () => true } },
      },
    };
    globals.window = fakeWindow;
    globals.document = {
      addEventListener: () => {},
      removeEventListener: () => {},
      documentElement: {},
    };
    globals.XMLHttpRequest = MockXhr;

    const transformStub = (payload: unknown): unknown => {
      transformedInputs.push(payload);
      if (payload && typeof payload === 'object') {
        (payload as Record<string, unknown>).__transformed = true;
      }
      return payload;
    };

    const restore = installInnertubeInterceptor(transformStub);
    // Second install while active returns idempotent NOOP.
    installInnertubeInterceptor(transformStub)();

    t.after(() => {
      restore();
      Response.prototype.json = prevResponseJson;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevDocument === undefined) delete globals.document;
      else globals.document = prevDocument;
      if (prevXhr === undefined) delete globals.XMLHttpRequest;
      else globals.XMLHttpRequest = prevXhr;
    });

    // _yttv JSON wrapper & ENABLE_PREVIEWS_WITH_SOUND were synced synchronously when host was ready;
    // calling syncYttvPreviewAndJson a second time reuses the already-wrapped parser without double-wrapping.
    syncYttvPreviewAndJson(transformStub);
    assert.equal(flagsMap.get('ENABLE_PREVIEWS_WITH_SOUND'), true);

    const wrappedYttvParse = (fakeWindow._yttv as { jsonMod: { JSON: { parse: typeof JSON.parse } } }).jsonMod.JSON
      .parse;
    assert.deepEqual(wrappedYttvParse('[1,2]'), [1, 2]);
    assert.equal(wrappedYttvParse('null'), null);
    assert.equal(wrappedYttvParse('42'), 42);
    assert.deepEqual(wrappedYttvParse('{"kind":"yttv"}'), { kind: 'yttv', __transformed: true });

    assert.deepEqual(JSON.parse('[1,2]'), [1, 2]);
    assert.equal(JSON.parse('null'), null);
    assert.equal(JSON.parse('42'), 42);
    assert.deepEqual(JSON.parse('{"kind":"global"}'), { kind: 'global', __transformed: true });

    // Outgoing fetch & XHR playbackContext body patching + passthrough cases.
    await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/player', {
      body: JSON.stringify({ playbackContext: { contentPlaybackContext: { vis: 0 } } }),
    });
    await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/browse', {
      body: JSON.stringify({ context: {} }),
    });
    await (fakeWindow.fetch as typeof fetch)('https://www.youtube.com/youtubei/v1/guide');
    assert.equal(
      prevJsonParse(sentFetchRequests[0]?.body || '{}').playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,
      true
    );
    assert.equal(prevJsonParse(sentFetchRequests[1]?.body || '{}').playbackContext, undefined);
    assert.equal(sentFetchRequests[2]?.body, undefined);

    const xhr = new MockXhr();
    xhr.send(JSON.stringify({ playbackContext: { contentPlaybackContext: { vis: 0 } } }));
    xhr.send('plain');
    xhr.send(null);
    assert.equal(
      prevJsonParse(String(sentXhrBodies[0])).playbackContext.contentPlaybackContext.isInlinePlaybackNoAd,
      true
    );
    assert.equal(sentXhrBodies[1], 'plain');
    assert.equal(sentXhrBodies[2], null);

    // Response.prototype.json skips external hosts and transforms InnerTube payloads.
    const sbResp = new Response(JSON.stringify({ segmentCount: 3 }));
    Object.defineProperty(sbResp, 'url', { value: 'https://sponsor.ajay.app/api/branding' });
    assert.deepEqual(await sbResp.json(), { segmentCount: 3 });

    const rydResp = new Response(JSON.stringify({ likes: 10 }));
    Object.defineProperty(rydResp, 'url', { value: 'https://returnyoutubedislikeapi.com/votes' });
    assert.deepEqual(await rydResp.json(), { likes: 10 });

    const ytResp = new Response(JSON.stringify({ kind: 'yt', videoDetails: { videoId: 'v1' } }));
    assert.deepEqual(await ytResp.json(), { kind: 'yt', videoDetails: { videoId: 'v1' }, __transformed: true });
    assert.deepEqual(
      transformedInputs.map((item) => (item as { kind?: string }).kind),
      ['yttv', 'global', 'yt']
    );
  });

  test('covers patchPlaybackContextBody edge cases and missing global guards cleanly', (t) => {
    const globals = globalThis as Record<string, unknown>;
    const prevWindow = globals.window;
    const prevXhr = globals.XMLHttpRequest;
    const prevResponse = globals.Response;
    const origError = console.error;
    let errorLogs = 0;
    console.error = () => {
      errorLogs++;
    };

    t.after(() => {
      console.error = origError;
      if (prevWindow === undefined) delete globals.window;
      else globals.window = prevWindow;
      if (prevXhr === undefined) delete globals.XMLHttpRequest;
      else globals.XMLHttpRequest = prevXhr;
      globals.Response = prevResponse;
    });

    assert.equal(patchPlaybackContextBody('no-context'), null);
    assert.equal(patchPlaybackContextBody('{"playbackContext":null}'), null);
    assert.equal(patchPlaybackContextBody('{"playbackContext":{}}'), null);
    assert.equal(
      patchPlaybackContextBody(
        JSON.stringify({ playbackContext: { contentPlaybackContext: { isInlinePlaybackNoAd: true } } })
      ),
      null
    );
    assert.equal(patchPlaybackContextBody('{"playbackContext":'), null);
    assert.equal(errorLogs, 1);

    globals.window = {};
    syncYttvPreviewAndJson((x) => x);
    delete globals.window;
    syncYttvPreviewAndJson((x) => x);

    // Install & restore when Response, XMLHttpRequest, and window are absent.
    delete globals.Response;
    delete globals.XMLHttpRequest;
    const restoreMinimal = installInnertubeInterceptor((x) => x);
    restoreMinimal();
  });
});
