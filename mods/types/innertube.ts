interface TextRun {
  text?: string;
}

export interface FormattedText {
  simpleText?: string;
  content?: string;
  runs?: TextRun[];
}

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

export interface WatchEndpoint {
  videoId?: string;
  params?: string;
  playlistId?: string;
}

interface BrowseEndpoint {
  browseId?: string;
  params?: string;
}

interface CustomActionPayload {
  action: string;
  parameters?: unknown;
}

export interface InnertubeCommand {
  clickTrackingParams?: string | null;
  watchEndpoint?: WatchEndpoint;
  browseEndpoint?: BrowseEndpoint;
  customAction?: CustomActionPayload;
  signalAction?: { signal: string };
  openPopupAction?: Record<string, unknown>;
  setClientSettingEndpoint?: {
    settingDatas?: Array<{
      clientSettingEnum?: { item: string };
      boolValue?: boolean;
      intValue?: string | number;
    }>;
  };
  showMenuCommand?: {
    menu?: {
      menuRenderer?: {
        items?: Array<Record<string, unknown>>;
      };
    };
  };
  commandExecutorCommand?: {
    commands?: InnertubeCommand[];
  };
  playlistEditEndpoint?: {
    customAction?: CustomActionPayload;
  };
  ypcGetOffersEndpoint?: Record<string, unknown>;
  reelWatchEndpoint?: Record<string, unknown>;
  showEngagementPanelEndpoint?: {
    identifier?: { tag?: string };
    globalConfiguration?: { params?: string };
  };
  [key: string]: unknown;
}

interface BadgeNode {
  label?: string;
  badgeText?: string;
  text?: string;
  badgeLabel?: string;
  style?: string;
  badgeStyle?: string;
}

export interface TileRenderer {
  contentId?: string;
  style?: string;
  contentType?: string;
  tvhtml5ShelfRendererType?: string;
  header?: {
    tileHeaderRenderer?: {
      thumbnail?: { thumbnails?: Thumbnail[] };
      thumbnailOverlays?: Array<Record<string, unknown>>;
    };
  };
  metadata?: {
    tileMetadataRenderer?: {
      title?: FormattedText;
      lines?: Array<Record<string, unknown>>;
    };
  };
  onSelectCommand?: InnertubeCommand;
  onLongPressCommand?: InnertubeCommand;
  [key: string]: unknown;
}

export interface LockupViewModel {
  contentId?: string;
  contentType?: string;
  contentImage?: {
    thumbnailViewModel?: {
      image?: { sources?: Thumbnail[] };
      overlays?: Array<Record<string, unknown>>;
    };
    collectionThumbnailViewModel?: {
      primaryThumbnail?: {
        thumbnailViewModel?: {
          image?: { sources?: Thumbnail[] };
        };
      };
    };
  };
  metadata?: {
    lockupMetadataViewModel?: {
      title?: FormattedText;
      metadata?: Record<string, unknown>;
    };
  };
  rendererContext?: {
    commandContext?: {
      onTap?: { innertubeCommand?: InnertubeCommand };
      onLongPress?: { innertubeCommand?: InnertubeCommand };
    };
  };
  [key: string]: unknown;
}

interface ShelfRenderer {
  title?: FormattedText | string;
  headerRenderer?: {
    shelfHeaderRenderer?: {
      title?: FormattedText | string;
    };
  };
  content?: Record<string, unknown>;
  tvhtml5ShelfRendererType?: string;
  [key: string]: unknown;
}

export interface FeedItem {
  adSlotRenderer?: unknown;
  feedNudgeRenderer?: unknown;
  surveyRenderer?: unknown;
  questionnaireRenderer?: unknown;
  richItemRenderer?: { content?: FeedItem };
  shelfRenderer?: ShelfRenderer;
  tileRenderer?: TileRenderer;
  lockupViewModel?: LockupViewModel;
  shortsLockupViewModel?: Record<string, unknown>;
  title?: FormattedText | string;
  badge?: BadgeNode;
  badgeRenderer?: BadgeNode;
  badgeText?: BadgeNode;
  badgeLabel?: BadgeNode;
  [key: string]: unknown;
}

export interface HiddenChannel {
  id: string;
  name: string;
}

export interface AdaptiveFormat {
  itag?: number;
  mimeType: string;
  audioTrack?: {
    id?: string;
    displayName?: string;
    audioIsDefault?: boolean;
  };
  [key: string]: unknown;
}

interface StreamingData {
  formats?: AdaptiveFormat[];
  adaptiveFormats?: AdaptiveFormat[];
  [key: string]: unknown;
}

export interface PlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
  };
  streamingData?: StreamingData;
  adPlacements?: unknown[];
  adSlots?: unknown[];
  playerAds?: unknown;
  paidContentOverlay?: unknown;
  [key: string]: unknown;
}
