import { clearGuideCache } from './innertube-calls.ts';

export function setupMemoryPressureListener(): void {
  if (typeof window !== 'undefined' && (window as any).h5vcc?.system?.onMemoryPressure) {
    (window as any).h5vcc.system.onMemoryPressure.addListener(() => {
      console.warn('Memory pressure detected, clearing caches...');
      clearGuideCache();
      // Additional application-wide cleanup here
    });
  }
}
