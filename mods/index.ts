import './core/trusted-types.ts';
import { initConfig } from './core/config.ts';
import './core/innertube-interceptor.ts';
import { setupMemoryPressureListener } from './core/memory-pressure.ts';

void initConfig();

setupMemoryPressureListener();

import './features/sponsorblock.ts';
import './ui/ui.ts';
import './ui/speed-ui.ts';
import './ui/settings.ts';
import './features/disable-whos-watching.ts';
import './features/more-subtitles.ts';
import './features/preferred-video-quality.ts';
import './ui/custom-ui.ts';
import './ui/custom-guide-action.ts';
import './ui/clock.ts';
import './features/remaining-time.ts';
import './features/rewind-on-pause.ts';
