import { clearRydCache } from '../features/return-youtube-dislike.ts';
import { clearDeArrowCache } from '../transforms/thumbnails.ts';
import { clearGuideCache } from './innertube-calls.ts';

export function setupMemoryPressureListener(): void {
  const onMemoryPressure = typeof window !== 'undefined' ? window.h5vcc?.system?.onMemoryPressure : undefined;
  if (typeof onMemoryPressure?.addListener === 'function') {
    onMemoryPressure.addListener(() => {
      console.warn('Memory pressure detected, clearing caches...');
      clearGuideCache();
      clearRydCache();
      clearDeArrowCache();
    });
  }
}
