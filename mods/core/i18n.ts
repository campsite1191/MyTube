const INTERPOLATION_PATTERN = /\{\{(\w+)\}\}/g;

export const EN_TRANSLATIONS = {
  'common.back': 'Back',
  'player.chapters.enterNudge': 'To view chapters, press the up arrow button',
  'player.chapters.navNudge': 'Navigate between chapters',
  'player.chapters.navNudgeA11y': 'Press the left or right arrow button to navigate between chapters',
  'player.chapters.title': 'Chapters',
  'player.playbackSpeed.fixStuttering': 'Fix stuttering (1.0001x)',
  'player.playbackSpeed.normal': 'Normal',
  'player.playbackSpeed.title': 'Playback speed',
  'sponsorblock.segments.filler': 'tangents',
  'sponsorblock.segments.interaction': 'interaction reminder',
  'sponsorblock.segments.intro': 'intro',
  'sponsorblock.segments.music_offtopic': 'non-music part',
  'sponsorblock.segments.outro': 'outro',
  'sponsorblock.segments.poi_highlight': 'highlight',
  'sponsorblock.segments.preview': 'recap or preview',
  'sponsorblock.segments.selfpromo': 'self-promotion',
  'sponsorblock.segments.sponsor': 'sponsored segment',
  'sponsorblock.toasts.skip': 'Skip {{segment}}',
  'sponsorblock.toasts.skipToHighlight': 'Skip to highlight',
  'toasts.feedbackSent': 'Feedback sent.',
  'videoMenu.dontRecommendChannel': "Don't recommend channel",
  'videoMenu.goToChannel': 'Go to channel',
  'videoMenu.notInterested': 'Not interested',
  'videoMenu.play': 'Play',
  'videoMenu.removeFromWatchLater': 'Remove from Watch later',
  'videoMenu.saveToWatchLater': 'Save to Watch later',
  'videoMenu.videoOptions': 'Video options',
} as const;

export type TranslationKey = keyof typeof EN_TRANSLATIONS;
export type TranslationVariables = Readonly<Record<string, string | number>>;

export function t(key: TranslationKey, variables?: TranslationVariables): string;
export function t(key: string, variables?: TranslationVariables): string;
export function t(key: string, variables?: TranslationVariables): string {
  if (!Object.hasOwn(EN_TRANSLATIONS, key)) return key;
  const template = EN_TRANSLATIONS[key as TranslationKey];
  if (!variables) return template;

  return template.replace(INTERPOLATION_PATTERN, (fullMatch, variableName: string) => {
    const value = Object.hasOwn(variables, variableName) ? variables[variableName] : undefined;
    return value !== undefined ? String(value) : fullMatch;
  });
}
