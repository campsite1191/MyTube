import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EN_TRANSLATIONS, t } from '../../mods/core/i18n.ts';

describe('typed English i18n lookup', () => {
  test('resolves static translation keys', () => {
    assert.equal(t('common.back'), 'Back');
    assert.equal(t('player.playbackSpeed.title'), 'Playback Speed');
    assert.equal(t('videoMenu.dontRecommendChannel'), "Don't Recommend Channel");
  });

  test('interpolates single and empty variable objects', () => {
    assert.equal(t('sponsorblock.toasts.skip', { segment: 'Intro' }), 'Skip Intro');
    assert.equal(t('sponsorblock.toasts.skip', { segment: 0 }), 'Skip 0');
  });

  test('preserves unmatched placeholders, ignores prototype keys, and returns unknown keys unchanged', () => {
    assert.equal(t('sponsorblock.toasts.skip', {}), 'Skip {{segment}}');
    assert.equal(t('sponsorblock.toasts.skip', { other: 'value' }), 'Skip {{segment}}');
    assert.equal(t('nonexistent.translation.key'), 'nonexistent.translation.key');
    assert.equal(t('toString'), 'toString');
    assert.equal(t('toString', { any: 'var' }), 'toString');
  });

  test('contains non-empty string values for every translation entry', () => {
    const entries = Object.entries(EN_TRANSLATIONS);
    assert.ok(entries.length > 0);
    for (const [key, value] of entries) {
      assert.equal(typeof value, 'string', `Expected string value for ${key}`);
      assert.ok(value.length > 0, `Expected non-empty value for ${key}`);
    }
  });
});
