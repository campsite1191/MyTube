import { t } from '../core/i18n.ts';
import { SettingActionRenderer, SettingsCategory } from './yt-ui.ts';

export function getPatchedSettings(settingsObject: Record<string, unknown>): Record<string, unknown> {
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

  const customSettingsCategory = SettingsCategory('custom_settings_category', [customSettingsOpenAction]);
  
  const currentItems = Array.isArray(settingsObject.items) ? settingsObject.items : [];
  return { 
    ...settingsObject, 
    items: [customSettingsCategory, ...currentItems] 
  };
}
