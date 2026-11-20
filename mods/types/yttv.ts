import type { InnertubeCommand } from './innertube.ts';

export interface YtPlayerStateObject {
  isPlaying?: boolean;
  isPaused?: boolean;
  isEnded?: boolean;
}

export interface YtVideoData {
  video_id?: string;
  title?: string;
  author?: string;
}

export interface YtQualityData {
  quality: string;
  qualityLabel: string;
}

export interface YtPlayerElement extends HTMLElement {
  getPlayerStateObject?: () => YtPlayerStateObject;
  getVideoData?: () => YtVideoData;
  getVideoStats?: () => Record<string, unknown>;
  getAvailableQualityData?: () => YtQualityData[];
  setPlaybackQualityRange?: (min: string, max: string) => void;
  getSubtitlesUserSettings?: () => Record<string, unknown>;
  updateSubtitlesUserSettings?: (settings: Record<string, unknown>, apply?: boolean) => void;
}

export interface KabukiInnerTubeClient {
  fetch: (req: Record<string, unknown>) => {
    subscribe: (onNext: (res: unknown) => void, onError?: (err: unknown) => void) => void;
  };
}

export interface CurrentIdentityService {
  get: () => Promise<unknown>;
}

export interface YttvResolveCommandHost {
  instance: {
    resolveCommand: (cmd: InnertubeCommand, unused?: unknown) => unknown;
  };
}

export interface YttvCommandExecutor {
  executeFunction: (command: unknown) => unknown;
  commandFunction?: new (actionName: string) => unknown;
}

declare global {
  interface Window {
    _yttv?: Record<string, unknown>;
    yt?: {
      config_?: {
        HL?: string;
        GL?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    h5vcc?: {
      system?: {
        onMemoryPressure?: {
          addListener?: (cb: () => void) => void;
        };
      };
      [key: string]: unknown;
    };
  }
}
