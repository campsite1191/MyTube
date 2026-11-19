import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { applyDislikeCountToActions, processRydResponse } from '../mods/features/return-youtube-dislike.ts';
import type { TransportActionItem } from '../mods/features/return-youtube-dislike.ts';

describe('return-youtube-dislike', () => {
  test('applies like count label onto like action button without throwing in Node', (t) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    const actions: TransportActionItem[] = [
      {
        type: 'LIKE',
        button: {
          likeButtonRenderer: {
            likeCountText: { simpleText: '1.2K' },
          },
        },
      },
      {
        type: 'DISLIKE',
        button: {
          dislikeButtonRenderer: {},
        },
      },
    ];

    const result = applyDislikeCountToActions(actions, 'dQw4w9WgXcQ');
    assert.equal(result[0]?.button?.likeButtonRenderer?.defaultText?.simpleText, '1.2K');
    assert.equal(result[0]?.button?.likeButtonRenderer?.tooltip, '1.2K');
  });

  test('processRydResponse handles null and non-player payloads safely', (t) => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    t.after(() => {
      globalThis.fetch = origFetch;
    });

    assert.doesNotThrow(() => processRydResponse(null));
    assert.doesNotThrow(() => processRydResponse({}));
    assert.doesNotThrow(() =>
      processRydResponse({
        videoDetails: { videoId: 'dQw4w9WgXcQ' },
        transportControls: { transportControlsRenderer: { promotedActions: [] } },
      })
    );
  });
});
