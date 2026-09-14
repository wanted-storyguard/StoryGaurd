export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "storyguard.appearance.v1";
export const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function themeStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

export function readThemePreference(storage = themeStorage()): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch { return "system"; }
}

export function saveThemePreference(preference: ThemePreference, storage = themeStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch { return false; }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function systemThemeIsDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia(SYSTEM_THEME_QUERY).matches;
}

export function applyTheme(preference: ThemePreference, systemDark: boolean): void {
  document.documentElement.dataset.theme = resolveTheme(preference, systemDark);
  document.documentElement.dataset.themePreference = preference;
}

/** Apply before React mounts, including the startup/loading screen. */
export function initializeTheme(): void {
  applyTheme(readThemePreference(), systemThemeIsDark());
}
