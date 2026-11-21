import './core/trusted-types.ts';
import { initConfig } from './core/config.ts';
import { preconnectOrigins, schedulePostFirstPaint, waitForDomReady } from './core/idle-scheduler.ts';
import './core/innertube-interceptor.ts';
import { setupMemoryPressureListener } from './core/memory-pressure.ts';
import { installDisableWhosWatching } from './features/disable-whos-watching.ts';
import { installPreferredVideoQuality } from './features/preferred-video-quality.ts';
import { installRemainingTime } from './features/remaining-time.ts';
import { installReturnYouTubeDislike } from './features/return-youtube-dislike.ts';
import { installRewindOnPause } from './features/rewind-on-pause.ts';
import { installSponsorBlock } from './features/sponsorblock.ts';
import { initClock } from './ui/clock.ts';

setupMemoryPressureListener();

const configReady = initConfig();
installDisableWhosWatching();

import './ui/ui.ts';
import './ui/speed-ui.ts';
import './ui/custom-ui.ts';
import './ui/custom-guide-action.ts';

void Promise.all([configReady, waitForDomReady()]).then(() => {
  schedulePostFirstPaint(() => {
    preconnectOrigins(['https://sponsor.ajay.app', 'https://returnyoutubedislikeapi.com']);
    initClock();
    installPreferredVideoQuality();
    installSponsorBlock();
    installRemainingTime();
    installReturnYouTubeDislike();
    installRewindOnPause();
  });
});
