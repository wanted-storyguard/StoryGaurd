import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { applyTheme, isThemePreference, readThemePreference, resolveTheme, saveThemePreference, systemThemeIsDark, SYSTEM_THEME_QUERY, THEME_STORAGE_KEY, themeStorage, type ResolvedTheme, type ThemePreference } from "../lib/theme";
import { syncNativeTheme } from "../lib/nativeTheme";

interface Appearance {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  saved: boolean;
  setPreference: (value: ThemePreference) => void;
}

const ThemeContext = createContext<Appearance | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(readThemePreference);
  const [systemDark, setSystemDark] = useState(systemThemeIsDark);
  const [saved, setSaved] = useState(true);
  const resolved = resolveTheme(preference, systemDark);

  useLayoutEffect(() => { applyTheme(preference, systemDark); }, [preference, systemDark]);

  useEffect(() => {
    void syncNativeTheme(preference).catch(() => {
      // A native failure must not prevent reading the manuscript or changing the UI theme.
      console.warn("[storyguard-appearance] Native window theme could not be applied.");
    });
  }, [preference]);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_THEME_QUERY);
    const onChange = () => setSystemDark(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== themeStorage() || (event.key !== null && event.key !== THEME_STORAGE_KEY)) return;
      setPreference(readThemePreference());
      setSaved(true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const value = useMemo<Appearance>(() => ({
    preference, resolved, saved,
    setPreference: next => {
      if (!isThemePreference(next)) return;
      setPreference(next);
      setSaved(saveThemePreference(next));
    },
  }), [preference, resolved, saved]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("ThemeProvider is required");
  return value;
}
