import { preconnectOrigins, schedulePostFirstPaint, waitForDomReady } from './core/idle-scheduler.ts';
import { installInnertubeInterceptor } from './core/innertube-interceptor.ts';
import { installDeArrow } from './features/dearrow.ts';
import { installDisableWhosWatching } from './features/disable-whos-watching.ts';
import { installHdStoryboard } from './features/hd-storyboard.ts';
import { installPlayerBarInfo } from './features/player-bar-info.ts';
import {
  installPreferredVideoQuality,
  seedPreferredAudioStorage,
  seedPreferredQualityStorage,
} from './features/preferred-video-quality.ts';
import { installReturnYouTubeDislike } from './features/return-youtube-dislike.ts';
import { installRewindOnPause } from './features/rewind-on-pause.ts';
import { installShortsMetadata } from './features/shorts-metadata.ts';
import { installSponsorBlock } from './features/sponsorblock.ts';
import { transformInnertubeResponseSync } from './transforms/innertube-response.ts';
import { installTransportControlsStyles } from './transforms/player-overlays.ts';
import { installThumbnailErrorFallback } from './transforms/thumbnails.ts';
import { initClock } from './ui/clock.ts';
import { installUiHooks } from './ui/ui.ts';

installInnertubeInterceptor(transformInnertubeResponseSync);
installThumbnailErrorFallback();
installUiHooks();
installDeArrow();
installDisableWhosWatching();
installHdStoryboard();
seedPreferredQualityStorage();
seedPreferredAudioStorage();

void waitForDomReady().then(() => {
  schedulePostFirstPaint(() => {
    preconnectOrigins(['https://sponsor.ajay.app', 'https://returnyoutubedislikeapi.com']);
    initClock();
    installPreferredVideoQuality();
    installSponsorBlock();
    installPlayerBarInfo();
    installReturnYouTubeDislike();
    installRewindOnPause();
    installShortsMetadata();
    installTransportControlsStyles();
  });
});
