import { configRead } from '../core/config.ts';
import { isRecord } from '../utils/type-guards.ts';

export interface SubtitleLanguageDescriptor {
  code: string;
  name: string;
}

export const PINNED_SUBTITLE_LANGUAGES: readonly SubtitleLanguageDescriptor[] = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
];

let languageDisplayNames: Intl.DisplayNames | null | undefined;

function getLanguageDisplayNames(): Intl.DisplayNames | null {
  if (languageDisplayNames !== undefined) return languageDisplayNames;
  try {
    languageDisplayNames =
      typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function'
        ? new Intl.DisplayNames(['en'], { type: 'language' })
        : null;
  } catch {
    languageDisplayNames = null;
  }
  return languageDisplayNames;
}

function readRecordPath(root: unknown, ...keys: string[]): Record<string, unknown> | null {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

/**
 * Resolves a human-readable English display name for a BCP-47 language code
 * using Cobalt's native `Intl.DisplayNames` API.
 */
export function resolveLanguageDisplayName(languageCode: string, fallbackName = languageCode): string {
  const formatter = getLanguageDisplayNames();
  if (!formatter || !languageCode) return fallbackName;

  try {
    return formatter.of(languageCode) || fallbackName;
  } catch {
    return fallbackName;
  }
}

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

export function hasAutoTranslateLanguage(
  items: readonly Record<string, unknown>[],
  languageCode: string,
  languageName: string
): boolean {
  return items.some((item) => {
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

function findSectionHeaderIndex(items: readonly Record<string, unknown>[], subtitleText: string): number {
  return items.findIndex(
    (item) => readRecordPath(item, 'overlayMessageRenderer', 'subtitle')?.simpleText === subtitleText
  );
}

/**
 * Pins missing target languages (default: English & Hindi) into YouTube TV's
 * auto-translate subtitle menu without duplicating existing entries.
 */
export function injectPinnedAutoTranslateLanguages(
  items: Record<string, unknown>[],
  languages: readonly SubtitleLanguageDescriptor[] = PINNED_SUBTITLE_LANGUAGES
): number {
  const optionsToInsert: Record<string, unknown>[] = [];

  for (const language of languages) {
    const displayName = language.name || resolveLanguageDisplayName(language.code, language.code);
    if (!hasAutoTranslateLanguage(items, language.code, displayName)) {
      optionsToInsert.push(createAutoTranslateLanguageOption(language.code, displayName));
    }
  }

  if (optionsToInsert.length === 0) return 0;

  const recommendedIndex = findSectionHeaderIndex(items, 'Recommended languages');
  if (recommendedIndex > -1) {
    items.splice(recommendedIndex + 1, 0, ...optionsToInsert);
    return optionsToInsert.length;
  }

  const otherLanguagesIndex = findSectionHeaderIndex(items, 'Other languages');
  if (otherLanguagesIndex > -1) {
    items.splice(otherLanguagesIndex, 0, ...optionsToInsert);
    return optionsToInsert.length;
  }

  items.unshift(...optionsToInsert);
  return optionsToInsert.length;
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

export function patchAutoTranslateCommand(command: unknown, enabled = configRead('enableShowUserLanguage')): boolean {
  if (!enabled) return false;
  const items = getAutoTranslateMenuItems(command);
  if (!items) return false;

  return injectPinnedAutoTranslateLanguages(items) > 0;
}
