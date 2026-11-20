import { t } from '../core/i18n.ts';
import { isRecord } from '../utils/type-guards.ts';
import { SettingActionRenderer, SettingsCategory } from './yt-ui.ts';

const CUSTOM_SETTINGS_CATEGORY_ID = 'custom_settings_category';

function buildCustomSettingsCategory(): Record<string, unknown> {
  const customSettingsOpenAction = SettingActionRenderer(
    t('settings.ttSettings.title'),
    'custom_settings_open_action',
    {
      customAction: {
        action: 'TT_SETTINGS_SHOW',
        parameters: [],
      },
    },
    t('settings.ttSettings.summary'),
    'https://www.gstatic.com/ytlr/img/parent_code.png'
  );

  return SettingsCategory(CUSTOM_SETTINGS_CATEGORY_ID, [customSettingsOpenAction]);
}

function hasCustomSettingsCategory(items: readonly unknown[]): boolean {
  return items.some(
    (entry) =>
      isRecord(entry) &&
      isRecord(entry.settingCategoryCollectionRenderer) &&
      entry.settingCategoryCollectionRenderer.categoryId === CUSTOM_SETTINGS_CATEGORY_ID
  );
}

/**
 * Prepends the custom settings category to a YouTube TV settings payload in place.
 */
export function patchSettingsInPlace(settingsObject: Record<string, unknown>): boolean {
  const currentItems = settingsObject.items;
  if (!Array.isArray(currentItems) || hasCustomSettingsCategory(currentItems)) return false;

  currentItems.unshift(buildCustomSettingsCategory());
  return true;
}

export function getPatchedSettings(settingsObject: Record<string, unknown>): Record<string, unknown> {
  const currentItems = Array.isArray(settingsObject.items) ? settingsObject.items : [];
  if (hasCustomSettingsCategory(currentItems)) return settingsObject;

  return {
    ...settingsObject,
    items: [buildCustomSettingsCategory(), ...currentItems],
  };
}
