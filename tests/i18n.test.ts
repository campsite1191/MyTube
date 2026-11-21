import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EN_TRANSLATIONS, t } from '../mods/core/i18n.ts';

describe('typed English i18n lookup', () => {
  test('resolves static translation keys', () => {
    assert.equal(t('common.back'), 'Back');
    assert.equal(t('player.playbackSpeed.title'), 'Playback Speed');
    assert.equal(t('videoMenu.dontRecommendChannel'), "Don't Recommend Channel");
  });

  test('interpolates single, multiple, and zero numeric variables', () => {
    assert.equal(t('sponsorblock.toasts.skipping', { segment: 'Intro' }), 'Skipping Intro');
    assert.equal(
      t('sponsorblock.toasts.notSkipping', { segment: 'Outro', count: 3 }),
      'Not skipping Outro (was skipped 3 times)'
    );
    assert.equal(
      t('sponsorblock.toasts.notSkipping', { segment: 'Intro', count: 0 }),
      'Not skipping Intro (was skipped 0 times)'
    );
  });

  test('preserves unmatched placeholders, ignores prototype keys, and returns unknown keys unchanged', () => {
    assert.equal(t('sponsorblock.toasts.skipping', {}), 'Skipping {{segment}}');
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
