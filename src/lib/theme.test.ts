import { describe, expect, it, vi } from "vitest";
import { isThemePreference, readThemePreference, resolveTheme, saveThemePreference, THEME_STORAGE_KEY } from "./theme";

const storageWith = (value: string | null) => ({ getItem: vi.fn(() => value), setItem: vi.fn() }) as unknown as Storage;

describe("appearance preferences", () => {
  it("follows the OS only when system is selected", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("ignores missing, old or untrusted stored values", () => {
    for (const value of [null, "", "auto", "<script>alert(1)</script>", '{"theme":"dark"}']) {
      expect(readThemePreference(storageWith(value))).toBe("system");
      expect(isThemePreference(value)).toBe(false);
    }
    expect(readThemePreference(storageWith("dark"))).toBe("dark");
  });
  it("keeps the application usable when storage is unavailable", () => {
    const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } } as unknown as Storage;
    expect(readThemePreference(blocked)).toBe("system");
    expect(saveThemePreference("dark", blocked)).toBe(false);
  });
  it("stores only the appearance preference under its own key", () => {
    const storage = storageWith(null);
    expect(saveThemePreference("light", storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(THEME_STORAGE_KEY, "light");
  });
});
