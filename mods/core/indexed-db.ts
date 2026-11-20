import { createStore, get as idbGet, set as idbSet } from 'idb-keyval';

const customStore = createStore('MyTubeDB', 'settings');

export function set(key: string, value: unknown): Promise<void> {
  return idbSet(key, value, customStore);
}

export async function get<T>(key: string, validate?: (data: unknown) => data is T): Promise<T | undefined> {
  const result = await idbGet<T>(key, customStore);
  if (validate && !validate(result)) {
    throw new Error(`Invalid data type for key: ${key}`);
  }
  return result;
}
