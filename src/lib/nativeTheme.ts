import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThemePreference } from "./theme";

/** Keep native window chrome aligned with the webview's appearance. */
export async function syncNativeTheme(preference: ThemePreference): Promise<void> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  await getCurrentWindow().setTheme(preference === "system" ? null : preference);
}
