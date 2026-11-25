import { isObjectLike, readRecordPath } from '../utils/type-guards.ts';
import { NOOP } from './lifecycle.ts';
import { whenYttvReady } from './yttv-bridge.ts';

const EXTERNAL_JSON_HOSTS = ['sponsor.ajay.app', 'returnyoutubedislikeapi.com'] as const;

const wrappedJsonParsers = new WeakSet<typeof JSON.parse>();
const rawJsonParse: typeof JSON.parse = JSON.parse;
let interceptorInstalled = false;

export function patchPlaybackContextBody(rawBody: string): string | null {
  if (!rawBody.includes('playbackContext')) return null;
  try {
    const body = rawJsonParse(rawBody);
    const playbackCtx = readRecordPath(body, 'playbackContext');
    const contentCtx = readRecordPath(playbackCtx, 'contentPlaybackContext');
    if (!playbackCtx || !contentCtx || contentCtx.isInlinePlaybackNoAd) return null;
    return JSON.stringify({
      ...body,
      playbackContext: {
        ...playbackCtx,
        contentPlaybackContext: {
          ...contentCtx,
          isInlinePlaybackNoAd: true,
        },
      },
    });
  } catch (e) {
    console.error('[InnertubeInterceptor] Failed to patch request body:', e);
    return null;
  }
}

function wrapJsonParseFn(
  origParse: typeof JSON.parse,
  transformPayload: (payload: unknown) => unknown
): typeof JSON.parse {
  if (wrappedJsonParsers.has(origParse)) return origParse;
  const wrappedParse = function (
    this: unknown,
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown
  ): unknown {
    const parsed = origParse.call(this, text, reviver);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return transformPayload(parsed);
    }
    return parsed;
  } as typeof JSON.parse;
  wrappedJsonParsers.add(origParse);
  wrappedJsonParsers.add(wrappedParse);
  return wrappedParse;
}

export function syncYttvPreviewAndJson(transformPayload: (payload: unknown) => unknown): void {
  if (typeof window === 'undefined' || !window._yttv) return;
  for (const entry of Object.values(window._yttv)) {
    if (entry instanceof Map && entry.has('ENABLE_PREVIEWS_WITH_SOUND')) {
      entry.set('ENABLE_PREVIEWS_WITH_SOUND', true);
    }
    if (isObjectLike(entry) && isObjectLike(entry.JSON) && typeof entry.JSON.parse === 'function') {
      entry.JSON.parse = wrapJsonParseFn(entry.JSON.parse as typeof JSON.parse, transformPayload);
    }
  }
}

export function installInnertubeInterceptor(transformPayload: (payload: unknown) => unknown): () => void {
  if (interceptorInstalled) return NOOP;
  interceptorInstalled = true;
  const restorers: Array<() => void> = [];

  // 1. Wrap JSON.parse so XHR, Response.text(), and inline XSSI-stripped payloads transform synchronously.
  const prevJsonParse = JSON.parse;
  JSON.parse = wrapJsonParseFn(prevJsonParse, transformPayload);
  restorers.push(() => {
    JSON.parse = prevJsonParse;
  });

  // 2. Intercept Response.json() (native V8 JSON path that bypasses JSON.parse).
  if (typeof Response !== 'undefined' && typeof Response.prototype?.json === 'function') {
    const origResponseJson = Response.prototype.json;
    Response.prototype.json = async function (this: Response) {
      const data: unknown = await origResponseJson.call(this);
      const url = this.url;
      if (url && EXTERNAL_JSON_HOSTS.some((host) => url.includes(host))) {
        return data;
      }
      return transformPayload(data);
    } as typeof Response.prototype.json;
    restorers.push(() => {
      Response.prototype.json = origResponseJson;
    });
  }

  // 3. Intercept fetch() & XMLHttpRequest.send() for outgoing playbackContext modifications.
  if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
    const targetWindow = window;
    const origFetch = targetWindow.fetch;
    targetWindow.fetch = (resource, init) => {
      if (init && typeof init.body === 'string') {
        const patchedBody = patchPlaybackContextBody(init.body);
        if (patchedBody !== null) {
          return origFetch.call(targetWindow, resource, { ...init, body: patchedBody });
        }
      }
      return origFetch.call(targetWindow, resource, init);
    };
    restorers.push(() => {
      targetWindow.fetch = origFetch;
    });
  }

  if (typeof XMLHttpRequest !== 'undefined' && typeof XMLHttpRequest.prototype?.send === 'function') {
    const xhrProto = XMLHttpRequest.prototype;
    const origXhrSend = xhrProto.send;
    xhrProto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      if (typeof body === 'string') {
        const patchedBody = patchPlaybackContextBody(body);
        if (patchedBody !== null) {
          origXhrSend.call(this, patchedBody);
          return;
        }
      }
      origXhrSend.call(this, body);
    };
    restorers.push(() => {
      xhrProto.send = origXhrSend;
    });
  }

  // 4. Sync feature flags & _yttv-scoped JSON.parse once YouTube TV runtime initializes.
  whenYttvReady(() => syncYttvPreviewAndJson(transformPayload));

  return () => {
    for (const restore of restorers) restore();
    interceptorInstalled = false;
  };
}
