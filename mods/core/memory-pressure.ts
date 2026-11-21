import { clearDeArrowCache } from '../transforms/thumbnails.ts';

export function setupMemoryPressureListener(): void {
  const onMemoryPressure = typeof window !== 'undefined' ? window.h5vcc?.system?.onMemoryPressure : undefined;
  if (typeof onMemoryPressure?.addListener === 'function') {
    onMemoryPressure.addListener(() => {
      console.warn('Memory pressure detected, clearing caches...');
      clearDeArrowCache();
    });
  }
}
