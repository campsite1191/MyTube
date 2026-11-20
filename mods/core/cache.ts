import QuickLRU from 'quick-lru';

const LRU_CACHE_MAX_SIZE = 2000;

/** Creates a bounded in-memory LRU cache (evicted by LRU order or memory pressure, with no TTL). */
export function createLruCache<V>(maxSize: number = LRU_CACHE_MAX_SIZE): QuickLRU<string, V> {
  return new QuickLRU<string, V>({ maxSize });
}
