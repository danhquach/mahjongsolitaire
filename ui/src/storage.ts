// Best-effort local persistence, shared by the settings screen and the
// auto-save (issue #14).
//
// Every read is defensive and every write is allowed to fail: Safari private
// mode throws on `setItem`, quota can run out, and a record left by an older
// build — or hand-edited — must never take the game down. Anything that cannot
// be read or parsed is treated as absent, so the caller falls back to its
// defaults (fresh settings, fresh deal) instead of failing to boot.

/** The slice of the DOM Storage API these modules need (`localStorage` fits). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` throws outright when site data is blocked; callers then run
 *  with in-memory state for the session. */
export function localKeyValueStorage(): KeyValueStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** Parsed JSON at `key`, or null when absent, unreadable, or malformed. */
export function readRecord(storage: KeyValueStorage | undefined, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write JSON at `key`. Returns whether it survived — never throws. */
export function writeRecord(
  storage: KeyValueStorage | undefined,
  key: string,
  value: unknown,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** Drop the record at `key`. Never throws. */
export function clearRecord(storage: KeyValueStorage | undefined, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do: a record we cannot delete is one we will overwrite.
  }
}
