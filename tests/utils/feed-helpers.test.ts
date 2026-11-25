import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { FeedItem, TileRenderer } from '../../mods/types/innertube.ts';
import {
  buildLongPressPayload,
  compactInPlace,
  formatCompactCount,
  unwrapFeedItem,
} from '../../mods/utils/feed-helpers.ts';

describe('unwrapFeedItem', () => {
  test('unwraps richItemRenderer.content and handles plain or invalid items', () => {
    const inner: FeedItem = { tileRenderer: { contentId: 'v1' } };
    assert.equal(unwrapFeedItem({ richItemRenderer: { content: inner } }), inner);
    assert.equal(unwrapFeedItem(inner), inner);
    assert.equal(unwrapFeedItem(null), null);
    assert.equal(unwrapFeedItem('invalid' as unknown as FeedItem), null);
  });
});

describe('compactInPlace', () => {
  test('removes matching entries in place and preserves survivor order', () => {
    const items = ['keep', 'remove', 'keep-2', 'remove-2'];
    assert.equal(
      compactInPlace(items, (item) => item.startsWith('remove')),
      items
    );
    assert.deepEqual(items, ['keep', 'keep-2']);
  });

  test('handles invalid, empty, all-kept, and all-removed inputs', () => {
    assert.equal(
      compactInPlace(null as unknown as string[], () => false),
      null
    );
    assert.equal(
      compactInPlace('not an array' as unknown as string[], () => false),
      'not an array'
    );
    assert.deepEqual(
      compactInPlace([], () => true),
      []
    );
    assert.deepEqual(
      compactInPlace([1, 2], () => false),
      [1, 2]
    );
    assert.deepEqual(
      compactInPlace([1, 2], () => true),
      []
    );
  });
});

describe('buildLongPressPayload', () => {
  test('builds a minimal tile payload readable by GO_TO_CHANNEL', () => {
    const tile: TileRenderer = {
      contentId: 'tile-id',
      unused: Array.from({ length: 100 }, (_, index) => index),
    };
    const item: FeedItem = { tileRenderer: tile };
    const payload = buildLongPressPayload(item, 'tile-id', { videoId: 'tile-id', params: 'P1' });

    assert.equal(payload.tileRenderer?.contentId, 'tile-id');
    assert.equal(payload.tileRenderer?.onSelectCommand?.watchEndpoint?.params, 'P1');
    assert.equal(payload.tileRenderer?.unused, undefined);
  });

  test('builds a minimal lockup payload readable by GO_TO_CHANNEL', () => {
    const payload = buildLongPressPayload({ lockupViewModel: { contentId: 'lockup-id' } }, 'lockup-id', {
      params: 'P2',
    });
    assert.equal(payload.lockupViewModel?.contentId, 'lockup-id');
    assert.equal(
      payload.lockupViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint?.params,
      'P2'
    );
  });

  test('stays acyclic even when the renderer references the command', () => {
    const tile: TileRenderer = { contentId: 'x' };
    const item: FeedItem = { tileRenderer: tile };
    const payload = buildLongPressPayload(item, 'x', { params: 'P' });
    tile.onLongPressCommand = { item: payload };
    assert.doesNotThrow(() => JSON.stringify(tile));
  });
});

describe('formatCompactCount', () => {
  test('formats values at unit boundaries and rounds small counts', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [999, '999'],
      [12.6, '13'],
      [1000, '1K'],
      [1200, '1.2K'],
      [10000, '10K'],
      [1500000, '1.5M'],
      [10000000, '10M'],
      [1234567890, '1.2B'],
      [10000000000, '10B'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(formatCompactCount(value), expected);
    }
  });

  test('accepts numeric strings and rejects invalid or negative values', () => {
    assert.equal(formatCompactCount('12'), '12');
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'not a count']) {
      assert.equal(formatCompactCount(value), '');
    }
  });
});
