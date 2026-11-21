import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ALLOWED_SUBTITLE_LANGUAGES,
  createAutoTranslateLanguageOption,
  filterAutoTranslateLanguages,
  patchAutoTranslateCommand,
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

describe('filterAutoTranslateLanguages', () => {
  test('filters auto-translate menu down to only English and Hindi, removing headers and other languages', () => {
    const items: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
      createAutoTranslateLanguageOption('es', 'Spanish'),
      { overlayMessageRenderer: { subtitle: { simpleText: 'Other languages' } } },
      createAutoTranslateLanguageOption('fr', 'French'),
      createAutoTranslateLanguageOption('ja', 'Japanese'),
    ];

    assert.equal(filterAutoTranslateLanguages(items), true);
    assert.equal(items.length, 2);
    assert.equal(readOptionCode(items[0]), 'en');
    assert.equal(readOptionCode(items[1]), 'hi');
    assert.equal(filterAutoTranslateLanguages(items, ALLOWED_SUBTITLE_LANGUAGES), false);
  });

  test('reuses existing English/Hindi rows to preserve selected state while stripping all other languages', () => {
    const existingHindi = createAutoTranslateLanguageOption('hi', 'Hindi');
    (existingHindi.compactLinkRenderer as Record<string, unknown>).secondaryIcon = {
      iconType: 'RADIO_BUTTON_CHECKED',
    };

    const items: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
      createAutoTranslateLanguageOption('de', 'German'),
      { overlayMessageRenderer: { subtitle: { simpleText: 'Other languages' } } },
      existingHindi,
      createAutoTranslateLanguageOption('zu', 'Zulu'),
    ];

    assert.equal(filterAutoTranslateLanguages(items), true);
    assert.equal(items.length, 2);
    assert.equal(readOptionCode(items[0]), 'en');
    assert.equal(items[1], existingHindi);
  });
});

describe('patchAutoTranslateCommand', () => {
  test('filters auto-translate overlay popups only when enabled', () => {
    const items: Record<string, unknown>[] = [
      { overlayMessageRenderer: { subtitle: { simpleText: 'Recommended languages' } } },
      createAutoTranslateLanguageOption('es', 'Spanish'),
      createAutoTranslateLanguageOption('hi', 'Hindi'),
    ];
    const popupCommand = createAutoTranslatePopup(items);

    assert.equal(patchAutoTranslateCommand(popupCommand, false), false);
    assert.equal(items.length, 3);

    assert.equal(patchAutoTranslateCommand(popupCommand, true), true);
    assert.equal(items.length, 2);
    assert.equal(readOptionCode(items[0]), 'en');
    assert.equal(readOptionCode(items[1]), 'hi');

    assert.equal(patchAutoTranslateCommand({ openPopupAction: { uniqueId: 'OTHER_POPUP' } }, true), false);
    assert.equal(patchAutoTranslateCommand(null, true), false);
  });
});
