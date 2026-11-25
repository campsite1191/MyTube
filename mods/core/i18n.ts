const INTERPOLATION_PATTERN = /\{\{(\w+)\}\}/g;

export const EN_TRANSLATIONS = {
  'common.back': 'Back',
  'player.chapters.enterNudge': 'To view chapters, press the up arrow button',
  'player.chapters.navNudge': 'Navigate between chapters',
  'player.chapters.navNudgeA11y': 'Press the left or right arrow button to navigate between chapters',
  'player.chapters.title': 'Chapters',
  'player.playbackSpeed.fixStuttering': 'Fix Stuttering (1.0001x)',
  'player.playbackSpeed.title': 'Playback Speed',
  'sponsorblock.segments.filler': 'Tangents',
  'sponsorblock.segments.interaction': 'Interaction Reminder',
  'sponsorblock.segments.intro': 'Intro',
  'sponsorblock.segments.music_offtopic': 'Non-Music Part',
  'sponsorblock.segments.outro': 'Outro',
  'sponsorblock.segments.poi_highlight': 'Highlight',
  'sponsorblock.segments.preview': 'Recap or Preview',
  'sponsorblock.segments.selfpromo': 'Self-Promotion',
  'sponsorblock.segments.sponsor': 'Sponsored Segment',
  'sponsorblock.toasts.skip': 'Skip {{segment}}',
  'sponsorblock.toasts.skipToHighlight': 'Skip to Highlight',
  'toasts.feedbackSent': 'Feedback sent.',
  'videoMenu.dontRecommendChannel': "Don't Recommend Channel",
  'videoMenu.goToChannel': 'Go to Channel',
  'videoMenu.notInterested': 'Not Interested',
  'videoMenu.play': 'Play',
  'videoMenu.removeFromWatchLater': 'Remove from Watch Later',
  'videoMenu.saveToWatchLater': 'Save to Watch Later',
  'videoMenu.videoOptions': 'Video Options',
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
