import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  PINNED_SUBTITLE_LANGUAGES,
  createAutoTranslateLanguageOption,
  hasAutoTranslateLanguage,
  injectPinnedAutoTranslateLanguages,
  patchAutoTranslateCommand,
  resolveLanguageDisplayName,
} from '../mods/features/more-subtitles.ts';

function readOptionCode(item: Record<string, unknown> | undefined): string | undefined {
  const renderer = item?.compactLinkRenderer as Record<string, unknown> | undefined;
  const serviceEndpoint = renderer?.serviceEndpoint as Record<string, unknown> | undefined;
  const executor = serviceEndpoint?.commandExecutorCommand as { commands?: Array<Record<string, unknown>> } | undefined;
  const selectCmd = executor?.commands?.[0]?.selectSubtitlesTrackCommand as
    | { translationLanguage?: { languageCode?: string } }
    | undefined;
  return selectCmd?.translationLanguage?.languageCode;
}

function createAutoTranslatePopup(items: Record<string, unknown>[]): Record<string, unknown> {
  return {
    openPopupAction: {
      uniqueId: 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE',
      popup: {
        overlaySectionRenderer: {
          overlay: {
            overlayTwoPanelRenderer: {
              actionPanel: {
                overlayPanelRenderer: {
                  content: {
                    overlayPanelItemListRenderer: {
                      items,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

describe('resolveLanguageDisplayName', () => {
  test('resolves English and Hindi via Intl.DisplayNames and falls back cleanly on invalid tags', () => {
    assert.equal(resolveLanguageDisplayName('en'), 'English');
    assert.equal(resolveLanguageDisplayName('hi'), 'Hindi');
    assert.equal(resolveLanguageDisplayName('invalid_tag!', 'Custom Fallback'), 'Custom Fallback');
    assert.equal(resolveLanguageDisplayName('invalid_tag!'), 'invalid_tag!');
    assert.equal(resolveLanguageDisplayName('', 'Empty'), 'Empty');
  });
});

describe('createAutoTranslateLanguageOption and hasAutoTranslateLanguage', () => {
  test('builds a valid YouTube TV subtitle translation item and detects duplicates by code or name', () => {
    const option = createAutoTranslateLanguageOption('hi', 'Hindi');
    const items = [option];

    assert.equal(readOptionCode(option), 'hi');
    assert.equal(hasAutoTranslateLanguage(items, 'hi', 'Different Name'), true);
    assert.equal(hasAutoTranslateLanguage(items, 'xx', 'Hindi'), true);
    assert.equal(hasAutoTranslateLanguage(items, 'es', 'Spanish'), false);
  });
});

describe('injectPinnedAutoTranslateLanguages', () => {
  test('inserts English and Hindi in order right after the Recommended languages header', () => {
    const items: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
      createAutoTranslateLanguageOption('es', 'Spanish'),
      { overlayMessageRenderer: { subtitle: { simpleText: 'Other languages' } } },
      createAutoTranslateLanguageOption('fr', 'French'),
    ];

    const injectedCount = injectPinnedAutoTranslateLanguages(items);

    assert.equal(injectedCount, 2);
    assert.equal(readOptionCode(items[1]), 'en');
    assert.equal(readOptionCode(items[2]), 'hi');
    assert.equal(readOptionCode(items[3]), 'es');
    assert.equal(readOptionCode(items[5]), 'fr');
  });

  test('inserts missing languages before Other languages or at the start when headers are absent', () => {
    const withOtherHeader: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Other languages' } } },
      createAutoTranslateLanguageOption('fr', 'French'),
    ];

    assert.equal(injectPinnedAutoTranslateLanguages(withOtherHeader), 2);
    assert.equal(readOptionCode(withOtherHeader[0]), 'en');
    assert.equal(readOptionCode(withOtherHeader[1]), 'hi');

    const withoutHeaders: Record<string, unknown>[] = [createAutoTranslateLanguageOption('ja', 'Japanese')];
    assert.equal(injectPinnedAutoTranslateLanguages(withoutHeaders), 2);
    assert.equal(readOptionCode(withoutHeaders[0]), 'en');
    assert.equal(readOptionCode(withoutHeaders[1]), 'hi');
    assert.equal(readOptionCode(withoutHeaders[2]), 'ja');
  });

  test('skips languages that are already present in the menu', () => {
    const items: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
      createAutoTranslateLanguageOption('en', 'English'),
    ];

    assert.equal(injectPinnedAutoTranslateLanguages(items), 1);
    assert.equal(readOptionCode(items[1]), 'hi');
    assert.equal(readOptionCode(items[2]), 'en');
    assert.equal(injectPinnedAutoTranslateLanguages(items, PINNED_SUBTITLE_LANGUAGES), 0);
  });
});

describe('patchAutoTranslateCommand', () => {
  test('patches only auto-translate overlay popups when enabled', () => {
    const items: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
    ];
    const popupCommand = createAutoTranslatePopup(items);

    assert.equal(patchAutoTranslateCommand(popupCommand, false), false);
    assert.equal(items.length, 1);

    assert.equal(patchAutoTranslateCommand(popupCommand, true), true);
    assert.equal(items.length, 3);
    assert.equal(readOptionCode(items[1]), 'en');
    assert.equal(readOptionCode(items[2]), 'hi');

    assert.equal(patchAutoTranslateCommand({ openPopupAction: { uniqueId: 'OTHER_POPUP' } }, true), false);
    assert.equal(patchAutoTranslateCommand(null, true), false);
  });
});
