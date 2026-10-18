// Reader state kept only in this browser, and the site's one guarded way to browser storage. Keep the
// keys and formats once readers have data under them: existing readers' data must stay readable as-is.
// Storage failures degrade silently.
import { useEffect, useSyncExternalStore } from "react";

export const KEYS = {
  read: "aihot-read-items",
  theme: "aihot-theme",
  font: "aihot-font",
  recentSearches: "aihot-recent-searches",
} as const;

const READ_LIMIT = 5000;
const RECENT_SEARCH_LIMIT = 10;
const RECENT_SEARCH_MAX_CHARS = 200;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

type StorageKind = "local" | "session";

// Reading the storage property itself throws where the browser blocks storage.
function storage(kind: StorageKind): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** A stored string; null when it is missing or storage is unavailable. */
export function readRaw(key: string, kind: StorageKind = "local"): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** A stored JSON value; null when it is missing, unreadable or not JSON. */
export function readJson(key: string, kind: StorageKind = "local"): unknown {
  const raw = readRaw(key, kind);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Stores a string, or removes the key for null; false when nothing was saved (storage full or unavailable). */
export function writeRaw(key: string, value: string | null, kind: StorageKind = "local"): boolean {
  try {
    const s = storage(kind);
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The keys in this browser's storage; none when it is unavailable. */
export function storedKeys(kind: StorageKind): string[] {
  const s = storage(kind);
  return s ? Array.from({ length: s.length }, (_, i) => s.key(i)!) : [];
}

// change notification (same tab via events, other tabs via the storage event)
const listeners = new Map<string, Set<() => void>>();
let subscribers = 0;
function emit(key?: string) {
  for (const [subscribedKey, callbacks] of listeners) {
    if (key === undefined || key === subscribedKey) for (const callback of callbacks) callback();
  }
}
function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== storage("local")) return;
  if (event.key === null || event.key === KEYS.font) unsavedFont = undefined;
  if (event.key === null) cache.clear();
  else cache.delete(event.key);
  // Clear the snapshot once, before notifying all cards. Each key is parsed at most once.
  emit(event.key ?? undefined);
}
function subscribeKey(key: string) {
  return (listener: () => void) => {
    let callbacks = listeners.get(key);
    if (!callbacks) listeners.set(key, callbacks = new Set());
    callbacks.add(listener);
    if (subscribers++ === 0) window.addEventListener("storage", onStorage);
    return () => {
      callbacks.delete(listener);
      if (callbacks.size === 0) listeners.delete(key);
      if (--subscribers === 0) window.removeEventListener("storage", onStorage);
    };
  };
}
const subscribeRead = subscribeKey(KEYS.read);
const subscribeTheme = subscribeKey(KEYS.theme);
const subscribeFont = subscribeKey(KEYS.font);
const subscribeRecentSearches = subscribeKey(KEYS.recentSearches);

// Snapshot cache so useSyncExternalStore gets stable references between changes.
const cache = new Map<string, unknown>();
function cached<T>(key: string, compute: () => T): T {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
}
function invalidate(key: string) {
  cache.delete(key);
  emit(key);
}

// Another tab may have written since this tab cached its snapshots (its storage event can still be on
// the way): every edit reads fresh values first.
function editLocalData<T>(change: () => T): T {
  cache.clear();
  return change();
}

// read items (LRU, newest first)
export function getReadIds(): string[] {
  return cached(KEYS.read, () => {
    const parsed = readJson(KEYS.read);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && ID_PATTERN.test(v)).slice(0, READ_LIMIT) : [];
  });
}

const readSetCache = { ids: null as string[] | null, set: new Set<string>() };
function getReadSet(): Set<string> {
  const ids = getReadIds();
  if (readSetCache.ids !== ids) {
    readSetCache.ids = ids;
    readSetCache.set = new Set(ids);
  }
  return readSetCache.set;
}

export function markRead(id: string) {
  editLocalData(() => {
    if (!ID_PATTERN.test(id)) return;
    const ids = getReadIds();
    if (ids[0] === id) return;
    const next = [id, ...ids.filter((v) => v !== id)].slice(0, READ_LIMIT);
    writeRaw(KEYS.read, JSON.stringify(next));
    invalidate(KEYS.read);
  });
}

// appearance
export type FontPreference = "browser" | null;
let unsavedFont: FontPreference | undefined;

export function getFontPreference(): FontPreference {
  return unsavedFont !== undefined ? unsavedFont : readRaw(KEYS.font) === "browser" ? "browser" : null;
}

export function setFontPreference(pref: FontPreference) {
  // A denied write still leaves the choice usable in this tab, like an unsaved preference.
  unsavedFont = writeRaw(KEYS.font, pref) ? undefined : pref;
  emit(KEYS.font);
}

export type ThemePreference = "light" | "dark" | null;

export function getThemePreference(): ThemePreference {
  const v = readRaw(KEYS.theme);
  return v === "light" || v === "dark" ? v : null;
}

export function setThemePreference(pref: ThemePreference) {
  writeRaw(KEYS.theme, pref);
  invalidate(KEYS.theme);
}

export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  if (pref) return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

const THEME_COLOR = { light: "#faf9f6", dark: "#13191c" } as const;

/** Puts a theme on the page: the document's data-theme and the browser's theme colour. */
export function applyTheme(theme: "light" | "dark", followsSystem: boolean) {
  document.documentElement.setAttribute("data-theme", theme);
  // The two theme-color tags answer the system scheme; a chosen theme sets both to its own colour.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes("dark") ? "dark" : "light";
    meta.content = followsSystem ? THEME_COLOR[scheme] : THEME_COLOR[theme];
  }
}

/**
 * Keeps the page on the reader's theme after the first paint: a choice made in another tab or by an
 * import, and the system switching between light and dark while the page follows it.
 */
export function useAppearanceSync() {
  const pref = useThemePreference();
  const font = useFontPreference();
  useEffect(() => {
    document.documentElement.setAttribute("data-font", getFontPreference() ?? "system");
  }, [font]);
  useEffect(() => {
    // Read the stored choice itself: during hydration the hook still reports the server's "none".
    const current = getThemePreference();
    applyTheme(resolvedTheme(current), current === null);
    if (current !== null) return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = () => applyTheme(query.matches ? "dark" : "light", true);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [pref]);
}

/** Inline script run before paint so the first frame already has the reader's appearance. */
export const APPEARANCE_BOOT_SCRIPT = `(function(){var f='system';try{f=localStorage.getItem('${KEYS.font}')==='browser'?'browser':'system'}catch(e){}document.documentElement.setAttribute('data-font',f);try{var t=localStorage.getItem('${KEYS.theme}');if(t==='light'||t==='dark'){var c=t==='dark'?'${THEME_COLOR.dark}':'${THEME_COLOR.light}';document.querySelectorAll('meta[name="theme-color"]').forEach(function(m){m.content=c})}else{t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

// recent searches (newest first, at most RECENT_SEARCH_LIMIT; this browser only)
function getRecentSearches(): string[] {
  return cached(KEYS.recentSearches, () => {
    const parsed = readJson(KEYS.recentSearches);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").slice(0, RECENT_SEARCH_LIMIT) : [];
  });
}

/** Puts a search first (the same words in another case replace the older entry). */
export function addRecentSearch(query: string) {
  const q = query.trim().slice(0, RECENT_SEARCH_MAX_CHARS);
  if (!q) return;
  const rest = getRecentSearches().filter((v) => v.toLowerCase() !== q.toLowerCase());
  writeRaw(KEYS.recentSearches, JSON.stringify([q, ...rest].slice(0, RECENT_SEARCH_LIMIT)));
  invalidate(KEYS.recentSearches);
}

export function clearRecentSearches() {
  writeRaw(KEYS.recentSearches, null);
  invalidate(KEYS.recentSearches);
}

// React hooks
const EMPTY_SET = new Set<string>();

export function useReadSet(): Set<string> {
  return useSyncExternalStore(subscribeRead, getReadSet, () => EMPTY_SET);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getThemePreference, () => null);
}

export function useFontPreference(): FontPreference {
  return useSyncExternalStore(subscribeFont, getFontPreference, () => null);
}

const NO_SEARCHES: string[] = [];
export function useRecentSearches(): string[] {
  return useSyncExternalStore(subscribeRecentSearches, getRecentSearches, () => NO_SEARCHES);
}
