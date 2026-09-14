import { afterEach, describe, expect, it, vi } from "vitest";
import { syncNativeTheme } from "./nativeTheme";

const { setTheme } = vi.hoisted(() => ({ setTheme: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTheme }) }));
afterEach(() => { vi.unstubAllGlobals(); setTheme.mockClear(); });

describe("native window appearance", () => {
  it("does not invoke native APIs in browser previews", async () => {
    vi.stubGlobal("window", {});
    await syncNativeTheme("dark");
    expect(setTheme).not.toHaveBeenCalled();
  });
  it("passes explicit appearances to the current desktop window", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await syncNativeTheme("light");
    await syncNativeTheme("dark");
    expect(setTheme.mock.calls).toEqual([["light"], ["dark"]]);
  });
  it("clears a manual override when following the system again", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    await syncNativeTheme("system");
    expect(setTheme).toHaveBeenCalledExactlyOnceWith(null);
  });
});
