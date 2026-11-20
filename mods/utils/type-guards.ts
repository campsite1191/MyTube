/**
 * Narrows an unknown value to a plain non-array object record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Narrows an unknown value to an indexable object or function (such as `_yttv` module constructors).
 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && (typeof value === 'object' || typeof value === 'function') && !Array.isArray(value);
}
