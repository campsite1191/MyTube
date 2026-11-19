import type { HiddenChannel } from '../types/innertube.ts';
import { get, set } from './indexed-db.ts';

export type SidebarContentItem = string | { browseId: string; title: string };

export interface ConfigSchema {
  enableAdBlock: boolean;
  enableSponsorBlock: boolean;
  enableSponsorBlockToasts: boolean;
  sponsorBlockManualSkips: string[];
  enableSponsorBlockSponsor: boolean;
  enableSponsorBlockIntro: boolean;
  enableSponsorBlockOutro: boolean;
  enableSponsorBlockInteraction: boolean;
  enableSponsorBlockSelfPromo: boolean;
  enableSponsorBlockPreview: boolean;
  enableSponsorBlockMusicOfftopic: boolean;
  enableSponsorBlockFiller: boolean;
  enableSponsorBlockHighlight: boolean;
  videoSpeed: number;
  preferredVideoQuality: string;
  enableDeArrow: boolean;
  enableDeArrowThumbnails: boolean;
  enableHqThumbnails: boolean;
  enableLongPress: boolean;
  enableShorts: boolean;
  enableWhoIsWatchingMenu: boolean;
  permanentlyEnableWhoIsWatchingMenu: boolean;
  enableWhosWatchingMenuOnAppExit: boolean;
  enableShowUserLanguage: boolean;
  enablePreviousNextButtons: boolean;
  enableSuperThanksButton: boolean;
  enableAIAskButton: boolean;
  enableSpeedControlsButton: boolean;
  enablePatchingVideoPlayer: boolean;
  enablePreviews: boolean;
  enableHideWatchedVideos: boolean;
  hideWatchedVideosThreshold: number;
  hideWatchedVideosPages: string[];
  hiddenChannels: HiddenChannel[];
  enableHideEndScreenCards: boolean;
  enableYouThereRenderer: boolean;
  enablePaidPromotionOverlay: boolean;
  speedSettingsIncrement: number;
  preferredVideoCodec: string;
  launchToOnStartup: string;
  reloadHomeOnStartup: boolean;
  disabledSidebarContents: string[];
  sidebarContentsOrder: SidebarContentItem[];
  disableChannelsOnSidebar: boolean;
  enableSigninReminder: boolean;
  sortSubscriptionsByAlphabet: boolean;
  enableClock: boolean;
  isClock12HourFormat: boolean;
  clockHideWhenVideoPlaying: boolean;
}

export type ConfigKey = keyof ConfigSchema;

export interface ConfigChangeDetail<K extends ConfigKey = ConfigKey> {
  key: K;
  value: ConfigSchema[K];
}

export type ConfigChangeListener = (event: CustomEvent<ConfigChangeDetail>) => void;

const CONFIG_KEY = 'ytaf-configuration';

export const defaultConfig: ConfigSchema = {
  enableAdBlock: true,
  enableSponsorBlock: true,
  enableSponsorBlockToasts: true,
  sponsorBlockManualSkips: ['intro', 'outro', 'filler', 'interaction', 'selfpromo', 'preview', 'music_offtopic', 'sponsor'],
  enableSponsorBlockSponsor: true,
  enableSponsorBlockIntro: true,
  enableSponsorBlockOutro: true,
  enableSponsorBlockInteraction: true,
  enableSponsorBlockSelfPromo: true,
  enableSponsorBlockPreview: false,
  enableSponsorBlockMusicOfftopic: false,
  enableSponsorBlockFiller: false,
  enableSponsorBlockHighlight: true,
  videoSpeed: 1,
  preferredVideoQuality: '2160p',
  enableDeArrow: true,
  enableDeArrowThumbnails: true,
  enableHqThumbnails: true,
  enableLongPress: true,
  enableShorts: true,
  enableWhoIsWatchingMenu: false,
  permanentlyEnableWhoIsWatchingMenu: false,
  enableWhosWatchingMenuOnAppExit: false,
  enableShowUserLanguage: true,
  enablePreviousNextButtons: true,
  enableSuperThanksButton: false,
  enableAIAskButton: false,
  enableSpeedControlsButton: true,
  enablePatchingVideoPlayer: false,
  enablePreviews: true,
  enableHideWatchedVideos: false,
  hideWatchedVideosThreshold: 80,
  hideWatchedVideosPages: [],
  hiddenChannels: [],
  enableHideEndScreenCards: true,
  enableYouThereRenderer: false,
  enablePaidPromotionOverlay: true,
  speedSettingsIncrement: 0.25,
  preferredVideoCodec: 'any',
  launchToOnStartup: '{"browseEndpoint":{"browseId":"FEtopics"}}',
  reloadHomeOnStartup: true,
  disabledSidebarContents: ['FEtopics_music', 'FEtopics_movies', 'FEtopics_live', 'FEtopics_gaming', 'FEtopics_sports', 'FEtopics_podcasts'],
  sidebarContentsOrder: ['search', 'FEtopics', 'FEsubscriptions', 'FElibrary', 'FEtopics_music', 'FEtopics_movies', 'FEtopics_live', 'FEtopics_gaming', 'FEtopics_news', 'FEtopics_sports', 'FEtopics_podcasts'],
  disableChannelsOnSidebar: true,
  enableSigninReminder: false,
  sortSubscriptionsByAlphabet: true,
  enableClock: true,
  isClock12HourFormat: false,
  clockHideWhenVideoPlaying: false,
};

let localConfig: ConfigSchema = { ...defaultConfig };

export async function initConfig(): Promise<void> {
  const stored = await get<ConfigSchema>(CONFIG_KEY);
  if (stored) {
    localConfig = { ...defaultConfig, ...stored };
  }
}

export function configRead<K extends ConfigKey>(key: K): ConfigSchema[K] {
  return localConfig[key] as ConfigSchema[K];
}

export async function configWrite<K extends ConfigKey>(key: K, value: ConfigSchema[K]): Promise<void> {
  localConfig[key] = value;
  await set(CONFIG_KEY, localConfig);
  configChangeEmitter.dispatchEvent(new CustomEvent('configChange', { detail: { key, value } }));
}

export interface ConfigChangeTarget {
  addEventListener(type: 'configChange', listener: ConfigChangeListener): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  removeEventListener(type: 'configChange', listener: ConfigChangeListener): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  dispatchEvent(event: Event): boolean;
}

export const configChangeEmitter: ConfigChangeTarget = new EventTarget() as ConfigChangeTarget;
