import { configRead } from '../core/config.ts';
import { findResolveCommandHost } from '../core/yttv-bridge.ts';
import type { InnertubeCommand } from '../types/innertube.ts';
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
  if (!isRecord(item) || !isRecord(item.compactLinkRenderer)) return null;
  const serviceEndpoint = item.compactLinkRenderer.serviceEndpoint;
  if (!isRecord(serviceEndpoint) || !isRecord(serviceEndpoint.commandExecutorCommand)) return null;

  const commands = serviceEndpoint.commandExecutorCommand.commands;
  if (!Array.isArray(commands) || commands.length === 0) return null;

  const firstCommand = commands[0];
  if (!isRecord(firstCommand) || !isRecord(firstCommand.selectSubtitlesTrackCommand)) return null;

  const translationLanguage = firstCommand.selectSubtitlesTrackCommand.translationLanguage;
  if (!isRecord(translationLanguage)) return null;

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

export function createAutoTranslateLanguageOption(
  languageCode: string,
  languageName: string
): Record<string, unknown> {
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
  return items.findIndex((item) => {
    if (!isRecord(item) || !isRecord(item.overlayMessageRenderer)) return false;
    const subtitle = item.overlayMessageRenderer.subtitle;
    return isRecord(subtitle) && subtitle.simpleText === subtitleText;
  });
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
    const displayName = resolveLanguageDisplayName(language.code, language.name);
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
  if (!isRecord(command) || !isRecord(command.openPopupAction)) return null;
  if (command.openPopupAction.uniqueId !== 'CLIENT_OVERLAY_TYPE_CAPTIONS_AUTO_TRANSLATE') return null;

  const popup = command.openPopupAction.popup;
  if (!isRecord(popup)) return null;

  const overlaySectionRenderer = popup.overlaySectionRenderer;
  if (!isRecord(overlaySectionRenderer)) return null;

  const overlay = overlaySectionRenderer.overlay;
  if (!isRecord(overlay)) return null;

  const overlayTwoPanelRenderer = overlay.overlayTwoPanelRenderer;
  if (!isRecord(overlayTwoPanelRenderer)) return null;

  const actionPanel = overlayTwoPanelRenderer.actionPanel;
  if (!isRecord(actionPanel)) return null;

  const overlayPanelRenderer = actionPanel.overlayPanelRenderer;
  if (!isRecord(overlayPanelRenderer)) return null;

  const content = overlayPanelRenderer.content;
  if (!isRecord(content)) return null;

  const overlayPanelItemListRenderer = content.overlayPanelItemListRenderer;
  if (!isRecord(overlayPanelItemListRenderer)) return null;

  const items = overlayPanelItemListRenderer.items;
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : null;
}

export function patchAutoTranslateCommand(
  command: unknown,
  enabled = configRead('enableShowUserLanguage')
): boolean {
  if (!enabled) return false;
  const items = getAutoTranslateMenuItems(command);
  if (!items) return false;

  return injectPinnedAutoTranslateLanguages(items) > 0;
}

export function installSubtitleAutoTranslatePatch(): boolean {
  if (typeof window === 'undefined') return false;
  const host = findResolveCommandHost();
  if (!host) return false;

  const originalResolveCommand = host.instance.resolveCommand;
  if (originalResolveCommand.isPatchedBySubtitleLocalization) return false;

  const wrappedResolveCommand: typeof originalResolveCommand = function (
    this: unknown,
    cmd: InnertubeCommand,
    unused?: unknown
  ) {
    patchAutoTranslateCommand(cmd);
    return originalResolveCommand.call(this, cmd, unused);
  };
  wrappedResolveCommand.isPatchedBySubtitleLocalization = true;
  host.instance.resolveCommand = wrappedResolveCommand;

  return true;
}
