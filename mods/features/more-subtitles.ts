import { readRecordPath } from '../utils/type-guards.ts';

export interface SubtitleLanguageDescriptor {
  code: string;
  name: string;
}

export const ALLOWED_SUBTITLE_LANGUAGES: readonly SubtitleLanguageDescriptor[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
];

function extractTranslationLanguage(item: unknown): { languageCode?: string; languageName?: string } | null {
  const exec = readRecordPath(item, 'compactLinkRenderer', 'serviceEndpoint', 'commandExecutorCommand');
  const commands = exec?.commands;
  const translationLanguage = Array.isArray(commands)
    ? readRecordPath(commands[0], 'selectSubtitlesTrackCommand', 'translationLanguage')
    : null;
  if (!translationLanguage) return null;

  return {
    languageCode: typeof translationLanguage.languageCode === 'string' ? translationLanguage.languageCode : undefined,
    languageName: typeof translationLanguage.languageName === 'string' ? translationLanguage.languageName : undefined,
  };
}

function findExistingLanguageItem(
  items: readonly Record<string, unknown>[],
  languageCode: string,
  languageName: string
): Record<string, unknown> | undefined {
  return items.find((item) => {
    const lang = extractTranslationLanguage(item);
    return Boolean(lang && (lang.languageCode === languageCode || lang.languageName === languageName));
  });
}

export function createAutoTranslateLanguageOption(languageCode: string, languageName: string): Record<string, unknown> {
  return {
    compactLinkRenderer: {
      title: { simpleText: languageName },
      serviceEndpoint: {
        commandExecutorCommand: {
          commands: [
            {
              selectSubtitlesTrackCommand: {
                translationLanguage: {
                  languageCode,
                  languageName,
                },
              },
            },
            {
              openClientOverlayAction: {
                type: 'CLIENT_OVERLAY_TYPE_CAPTIONS_LANGUAGE',
                updateAction: true,
              },
            },
            {
              signalAction: { signal: 'POPUP_BACK' },
            },
          ],
        },
      },
      secondaryIcon: { iconType: 'RADIO_BUTTON_UNCHECKED' },
    },
  };
}

/**
 * Replaces YouTube TV's auto-translate subtitle menu items with only the allowed
 * target languages (default: English & Hindi), reusing existing rows to preserve active state.
 */
export function filterAutoTranslateLanguages(
  items: Record<string, unknown>[],
  languages: readonly SubtitleLanguageDescriptor[] = ALLOWED_SUBTITLE_LANGUAGES
): boolean {
  const nextItems = languages.map(
    ({ code, name }) => findExistingLanguageItem(items, code, name) ?? createAutoTranslateLanguageOption(code, name)
  );
  const unchanged = items.length === nextItems.length && items.every((item, idx) => item === nextItems[idx]);
  if (unchanged) return false;

  items.splice(0, items.length, ...nextItems);
  return true;
}

function getAutoTranslateMenuItems(command: unknown): Record<string, unknown>[] | null {
  const openPopup = readRecordPath(command, 'openPopupAction');
  if (openPopup?.uniqueId !== 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE') return null;

  const list = readRecordPath(
    openPopup.popup,
    'overlaySectionRenderer',
    'overlay',
    'overlayTwoPanelRenderer',
    'actionPanel',
    'overlayPanelRenderer',
    'content',
    'overlayPanelItemListRenderer'
  );
  return Array.isArray(list?.items) ? (list.items as Record<string, unknown>[]) : null;
}

export function patchAutoTranslateCommand(command: unknown): boolean {
  const items = getAutoTranslateMenuItems(command);
  if (!items) return false;

  return filterAutoTranslateLanguages(items);
}
