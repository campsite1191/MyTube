import { preconnectOrigins, schedulePostFirstPaint, waitForDomReady } from './core/idle-scheduler.ts';
import './core/trusted-types.ts';
import './core/innertube-interceptor.ts';
import { installDisableWhosWatching } from './features/disable-whos-watching.ts';
import { installHdStoryboard } from './features/hd-storyboard.ts';
import { installPlayerBarInfo } from './features/player-bar-info.ts';
import { installPreferredVideoQuality, seedPreferredQualityStorage } from './features/preferred-video-quality.ts';
import { installReturnYouTubeDislike } from './features/return-youtube-dislike.ts';
import { installRewindOnPause } from './features/rewind-on-pause.ts';
import { installSponsorBlock } from './features/sponsorblock.ts';
import { installTransportControlsStyles } from './transforms/player-overlays.ts';
import { installShortsMetadata } from './transforms/shorts-metadata.ts';
import { setupMemoryPressureListener } from './transforms/thumbnails.ts';
import { initClock } from './ui/clock.ts';
import './ui/ui.ts';

setupMemoryPressureListener();
installDisableWhosWatching();
installHdStoryboard();
seedPreferredQualityStorage();

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
